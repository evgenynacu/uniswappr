/* eslint-disable */
const { ethers, BigNumber } = require('ethers')
const axios = require('axios')
const xtokenPositionManagerAbi = require('../abis/xtokenPositionManager.json')
const uniswapV3PositionManagerAbi = require('../abis/uniswapV3PositionManager.json')
const {
  XTOKEN_POSITION_MANAGER,
  UNISWAP_V3_POSITION_MANAGER,
} = require('./constants')
const { getPriceFromTicksFormatted, chainIdToAlchemyUrl } = require('../utils')
const { getSwapParams } = require('./getSwapParams')

export const reposition = async (signerOrProvider, repositionParams) => {
  const xtokenPositionManager = new ethers.Contract(
    XTOKEN_POSITION_MANAGER,
    xtokenPositionManagerAbi,
    signerOrProvider
  )
  const uniPositionManager = new ethers.Contract(
    UNISWAP_V3_POSITION_MANAGER,
    uniswapV3PositionManagerAbi,
    signerOrProvider
  )

  const approvedAddress = await uniPositionManager.getApproved(
    repositionParams.positionId
  )

  if (approvedAddress != XTOKEN_POSITION_MANAGER) {
    let approval = await uniPositionManager.approve(
      XTOKEN_POSITION_MANAGER,
      repositionParams.positionId
    )
    approval = await approval.wait()
    console.log('nft approved')
  }

  let repositionTx = await xtokenPositionManager.reposition(repositionParams)
  repositionTx = await repositionTx.wait()
  return repositionTx
}

export const repositionSim = async (
  signerOrProvider,
  positionData,
  chainId,
  repositionParams
) => {
  /* Simulation */
  const { REACT_APP_ALCHEMY_API_KEY } = process.env
  const xtokenPositionManager = new ethers.Contract(
    XTOKEN_POSITION_MANAGER,
    xtokenPositionManagerAbi,
    signerOrProvider
  )
  const uniPositionManager = new ethers.Contract(
    UNISWAP_V3_POSITION_MANAGER,
    uniswapV3PositionManagerAbi,
    signerOrProvider
  )

  const unsignedApprovalTx =
    await uniPositionManager.populateTransaction.approve(
      XTOKEN_POSITION_MANAGER,
      repositionParams.positionId
    )

  const approvalTx = {
    from: signerOrProvider._address,
    to: UNISWAP_V3_POSITION_MANAGER,
    value: '0x0',
    data: unsignedApprovalTx.data,
  }

  const { positionId, newTickLower, newTickUpper } = repositionParams
  const { token0, token1 } = positionData
  const token0Decimals = token0.decimals
  const token1Decimals = token1.decimals

  const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1)
  const collectableFees = await uniPositionManager.callStatic.collect({
    tokenId: positionId,
    recipient: signerOrProvider._address,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  })

  const { tokenToSwap, tokenAmountToSwap } = await getSwapParams(
    signerOrProvider,
    positionId,
    newTickLower,
    newTickUpper,
    positionData.poolFee,
    collectableFees
  )

  const fromToken = tokenToSwap === 'token0' ? token0.address : token1.address
  const toToken = tokenToSwap === 'token0' ? token1.address : token0.address

  let oneInchData = await getOneInchCalldata(
    xtokenPositionManager.address,
    signerOrProvider.provider._network.chainId,
    tokenAmountToSwap,
    fromToken,
    toToken
  )

  let params = {
    positionId,
    newTickLower,
    newTickUpper,
    minAmount0Staked: 0,
    minAmount1Staked: 0,
    oneInchData,
  }
  const unsignedRepositionTx =
    await xtokenPositionManager.populateTransaction.reposition(params)

  const repositionTx = {
    from: signerOrProvider._address,
    to: xtokenPositionManager.address,
    value: '0x0',
    data: unsignedRepositionTx.data,
  }

  const urlNetwork = chainIdToAlchemyUrl(chainId)

  const options = {
    method: 'POST',
    url: `https://${urlNetwork}.g.alchemy.com/v2/${REACT_APP_ALCHEMY_API_KEY}`,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    data: {
      id: 1,
      jsonrpc: '2.0',
      method: 'alchemy_simulateExecutionBundle',
      params: [[approvalTx, repositionTx]],
    },
  }

  const resp = await axios.request(options)
  const logs = resp.data.result[1].logs

  const collectEvents = logs.filter((l) => l.decoded?.eventName == 'Collect')
  const decreaseEvents = logs.filter(
    (l) => l.decoded?.eventName == 'DecreaseLiquidity'
  )
  const swapEvent = logs.filter((l) => l.decoded?.eventName == 'Swap')
  const swappedEvent = logs.filter((l) => l.decoded?.eventName == 'Swapped')
  const transferEvents = logs.filter((l) => l.decoded?.eventName == 'Transfer')
  const mintEvent = logs.filter((l) => l.decoded?.eventName == 'Mint')
  const repositionEvent = logs.filter(
    (l) => l.decoded?.eventName == 'Repositioned'
  )

  const feeAmountsCollected = getCollectedFeeAmounts(
    collectEvents,
    token0Decimals,
    token1Decimals
  )
  const tokenAmountsRemoved = getRemovedLiquidityAmounts(
    decreaseEvents,
    token0Decimals,
    token1Decimals
  )

  const swapData = getSwapData(swapEvent, swappedEvent, token0, token1)

  const newPositionData = getNewPositionData(
    mintEvent,
    repositionEvent,
    token0,
    token1,
    signerOrProvider.provider._network.chainId
  )

  const newStakedAmounts = getNewStakedAmounts(
    mintEvent,
    repositionEvent,
    token0Decimals,
    token1Decimals
  )

  const { token0Text, token1Text } = getTokenRetrievals(
    logs,
    transferEvents,
    token0,
    token1,
    signerOrProvider._address
  )

  const slice = (str) => String(str).slice(0, 7)
  const symbol0 = token0.symbol
  const symbol1 = token1.symbol

  const feesCollect = `Collect ${slice(
    feeAmountsCollected.token0Fees
  )} ${symbol0} + ${slice(feeAmountsCollected.token1Fees)} ${symbol1} in fees`
  const tokensWithdraw = `Withdraw ${slice(
    tokenAmountsRemoved.token0Removed
  )} ${symbol0} + ${slice(
    tokenAmountsRemoved.token1Removed
  )} ${symbol1} in liquidity`
  const mintPosition = `Mint new position with ticks range [${newPositionData.newLowerTick}, ${newPositionData.newUpperTick}]`
  const priceRangePosition = `Tick range equivalent to ${newPositionData.prices}`
  const tokensDeposit = `Deposit ${slice(
    newStakedAmounts.token0Staked
  )} ${symbol0} + ${slice(
    newStakedAmounts.token1Staked
  )} ${symbol1} in new position`

  const projectedActions = [
    feesCollect,
    tokensWithdraw,
    swapData,
    mintPosition,
    priceRangePosition,
    tokensDeposit,
    token0Text,
    token1Text,
  ]

  const unformattedNewStakedAmounts = getNewStakedAmountsUnformatted(
    mintEvent,
    repositionEvent
  )
  const fullRepositionParams = {
    positionId: Number(positionId),
    newTickLower: Number(newTickLower),
    newTickUpper: Number(newTickUpper),
    minAmount0Staked: BigNumber.from(unformattedNewStakedAmounts.token0Staked)
      .mul(99)
      .div(100),
    minAmount1Staked: BigNumber.from(unformattedNewStakedAmounts.token1Staked)
      .mul(99)
      .div(100),
    oneInchData,
  }

  return {
    feeAmountsCollected,
    tokenAmountsRemoved,
    swapData,
    newPositionData,
    newStakedAmounts,
    projectedActions,
    repositionParams: fullRepositionParams,
  }
}

export const getOneInchCalldata = async (
  lpSwapperAddress,
  networkId,
  swapAmount,
  fromToken,
  toToken
) => {
  if (swapAmount.toString() === '0') return '0x'

  const url = `https://li.quest/v1/quote?fromChain=${swapChain}&toChain=${swapChain}&fromToken=${fromToken}&toToken=${toToken}&fromAddress=${lpSwapperAddress}&fromAmount=${swapAmount}&slippage=${maxSlippage}`
  const res = await axios.get(url)
  return res.data.transactionRequest.data
}

const maxSlippage = "0.005"
const swapChain = "42161" // arb

const getCollectedFeeAmounts = (
  collectEvents,
  token0Decimals,
  token1Decimals
) => {
  const token0FeesCollected = !!collectEvents[0].decoded.inputs[4]
    ? collectEvents[0].decoded.inputs[4].value
    : 0
  const token1FeesCollected = !!collectEvents[0].decoded.inputs[5]
    ? collectEvents[0].decoded.inputs[5].value
    : 0
  return {
    token0Fees: Number.parseFloat(
      token0FeesCollected / 10 ** token0Decimals
    ).toFixed(6),
    token1Fees: Number.parseFloat(
      token1FeesCollected / 10 ** token1Decimals
    ).toFixed(6),
  }
}

const getRemovedLiquidityAmounts = (
  decreaseEvents,
  token0Decimals,
  token1Decimals
) => {
  const token0Removed = decreaseEvents[0].decoded.inputs[2].value
  const token1Removed = decreaseEvents[0].decoded.inputs[3].value
  return {
    token0Removed: token0Removed / 10 ** token0Decimals,
    token1Removed: token1Removed / 10 ** token1Decimals,
  }
}

const getNewStakedAmounts = (
  mintEvent,
  repositionEvent,
  token0Decimals,
  token1Decimals
) => {
  const { token0Staked, token1Staked } = getNewStakedAmountsUnformatted(
    mintEvent,
    repositionEvent
  )
  return {
    token0Staked: token0Staked / 10 ** token0Decimals,
    token1Staked: token1Staked / 10 ** token1Decimals,
  }
}

const getNewStakedAmountsUnformatted = (mintEvent, repositionEvent) => {
  const mintInputs = mintEvent?.decoded?.inputs
  const repositionInputs = repositionEvent[0]?.decoded?.inputs

  if (!mintInputs) {
    return {
      token0Staked: repositionInputs[6].value,
      token1Staked: repositionInputs[7].value,
    }
  }

  return {
    token0Staked: mintInputs[5].value,
    token1Staked: mintInputs[6].value,
  }
}

const getNewPositionData = (
  mintEvent,
  repositionEvent,
  token0,
  token1,
  chainId
) => {
  const mintInputs = mintEvent[0]?.decoded?.inputs
  const repositionInputs = repositionEvent[0]?.decoded?.inputs

  let newLowerTick, newUpperTick
  if (!mintInputs) {
    newLowerTick = repositionInputs[4].value
    newUpperTick = repositionInputs[5].value
  } else {
    newLowerTick = mintInputs[1].value
    newUpperTick = mintInputs[2].value
  }

  const prices = getPriceFromTicksFormatted(
    Number(newLowerTick),
    Number(newUpperTick),
    token0,
    token1,
    chainId
  )

  return {
    newLowerTick,
    newUpperTick,
    prices,
  }
}

const getSwapData = (swapEvent, swappedEvent, token0, token1) => {
  if (!swapEvent.length && !swappedEvent.length) {
    return `No swaps performed`
  }

  let inputs
  let tokenOut, tokenIn, tokenOutAmount, tokenInAmount

  if (!swapEvent.length) {
    // use swappedEvent
    inputs = swappedEvent[0].decoded.inputs
    if (inputs[1].value == token0.address) {
      // token0 is tokenOut
      tokenOut = token0.symbol
      tokenIn = token1.symbol
      tokenOutAmount = inputs[4].value / 10 ** token0.decimals
      tokenInAmount = inputs[5].value / 10 ** token1.decimals
    } else {
      tokenOut = token1.symbol
      tokenIn = token0.symbol
      tokenOutAmount = inputs[4].value / 10 ** token1.decimals
      tokenInAmount = inputs[5].value / 10 ** token0.decimals
    }
  } else {
    // use swapEvent
    inputs = swapEvent[0].decoded.inputs
    if (Number(inputs[2].value) > 0) {
      // token0 swapped out, token1 received in
      tokenOut = token0.symbol
      tokenIn = token1.symbol
      tokenOutAmount = inputs[2].value / 10 ** token0.decimals
      tokenInAmount = inputs[5].value / 10 ** token1.decimals
    } else {
      tokenOut = token1.symbol
      tokenIn = token0.symbol
      tokenOutAmount = inputs[3].value / 10 ** token1.decimals
      tokenInAmount = inputs[4].value / 10 ** token0.decimals
    }
  }

  return `Swap ${String(tokenOutAmount).slice(0, 7)} ${tokenOut} for ${String(
    tokenInAmount
  ).slice(0, 7)} ${tokenIn}`
}

const getTokenRetrievals = (
  allEvents,
  transferEvents,
  token0,
  token1,
  userAddress
) => {
  const retrievedEvents = transferEvents.filter(
    (e) => ethers.utils.getAddress(e.decoded.inputs[1].value) == userAddress
  )
  const token0Retrieval = retrievedEvents.find(
    (e) => ethers.utils.getAddress(e.address) == token0.address
  )
  const token1Retrieval = retrievedEvents.find(
    (e) => ethers.utils.getAddress(e.address) == token1.address
  )

  let token0Retrieved, token1Retrieved

  if (!token0Retrieval) {
    const nonDecodedEvent = allEvents.filter((e) => {
      return (
        ethers.utils.isAddress(e.topics[2]) &&
        ethers.utils.getAddress(e.address) === token0.address &&
        userAddress === ethers.utils.getAddress(e.topics[2])
      )
    })
    token0Retrieved = parseInt(nonDecodedEvent[0].data, 16)
  } else {
    token0Retrieved = token0Retrieval.decoded.inputs[2].value
  }

  if (!token1Retrieval) {
    const nonDecodedEvent = allEvents.filter((e) => {
      return (
        ethers.utils.isAddress(e.topics[2]) &&
        ethers.utils.getAddress(e.address) === token1.address &&
        userAddress === ethers.utils.getAddress(e.topics[2])
      )
    })
    token1Retrieved = parseInt(nonDecodedEvent[0].data, 16)
  } else {
    token1Retrieved = token1Retrieval.decoded.inputs[2].value
  }

  token0Retrieved = token0Retrieved / 10 ** token0.decimals
  token1Retrieved = token1Retrieved / 10 ** token1.decimals

  const token0Text = `${token0Retrieved.toFixed(6)} ${token0.symbol}`
  const token1Text = `${token1Retrieved.toFixed(6)} ${token1.symbol}`

  return {
    token0Text: `Return ${token0Text} to user`,
    token1Text: `Return ${token1Text} to user`,
  }
}
