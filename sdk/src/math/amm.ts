import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
	BID_ASK_SPREAD_PRECISION,
	ONE,
	// QUOTE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	MarketAccount,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import { squareRootBN } from '..';

import { OraclePriceData } from '../oracles/types';
import {
	calculateRepegCost,
	calculateAdjustKCost,
	calculateBudgetedPeg,
} from './repeg';
export function calculateNewAmm(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN, BN, BN] {
	let pKNumer = new BN(1);
	let pKDenom = new BN(1);

	const targetPrice = oraclePriceData.price;
	let newPeg = targetPrice
		.mul(amm.baseAssetReserve)
		.div(amm.quoteAssetReserve)
		.add(MARK_PRICE_PRECISION.div(PEG_PRECISION).div(new BN(2)))
		.div(MARK_PRICE_PRECISION.div(PEG_PRECISION));
	let prePegCost = calculateRepegCost(amm, newPeg);

	const totalFeeLB = amm.totalExchangeFee.div(new BN(2));
	const budget = BN.max(ZERO, amm.totalFeeMinusDistributions.sub(totalFeeLB));

	if (prePegCost.gt(budget)) {
		[pKNumer, pKDenom] = [new BN(999), new BN(1000)];
		const deficitMadeup = calculateAdjustKCost(amm, pKNumer, pKDenom);
		assert(deficitMadeup.lte(new BN(0)));
		prePegCost = budget.add(deficitMadeup.abs());
		const newAmm = Object.assign({}, amm);
		newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pKDenom);
		newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pKDenom);
		const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
		newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
		const directionToClose = amm.netBaseAssetAmount.gt(ZERO)
			? PositionDirection.SHORT
			: PositionDirection.LONG;

		const [newQuoteAssetReserve, _newBaseAssetReserve] =
			calculateAmmReservesAfterSwap(
				newAmm,
				'base',
				amm.netBaseAssetAmount.abs(),
				getSwapDirection('base', directionToClose)
			);

		newAmm.terminalQuoteAssetReserve = newQuoteAssetReserve;

		newPeg = calculateBudgetedPeg(newAmm, prePegCost, targetPrice);
		prePegCost = calculateRepegCost(newAmm, newPeg);
	}

	return [prePegCost, pKNumer, pKDenom, newPeg];
}

export function calculateUpdatedAMM(
	amm: AMM,
	oraclePriceData: OraclePriceData
): AMM {
	if (amm.curveUpdateIntensity == 0) {
		return amm;
	}
	const newAmm = Object.assign({}, amm);
	const [prepegCost, pKNumer, pKDenom, newPeg] = calculateNewAmm(
		amm,
		oraclePriceData
	);

	newAmm.baseAssetReserve = newAmm.baseAssetReserve.mul(pKNumer).div(pKDenom);
	newAmm.sqrtK = newAmm.sqrtK.mul(pKNumer).div(pKDenom);
	const invariant = newAmm.sqrtK.mul(newAmm.sqrtK);
	newAmm.quoteAssetReserve = invariant.div(newAmm.baseAssetReserve);
	newAmm.pegMultiplier = newPeg;

	const directionToClose = amm.netBaseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, _newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			newAmm,
			'base',
			amm.netBaseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	newAmm.terminalQuoteAssetReserve = newQuoteAssetReserve;

	newAmm.totalFeeMinusDistributions =
		newAmm.totalFeeMinusDistributions.sub(prepegCost);

	return newAmm;
}

export function calculateUpdatedAMMSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): { baseAssetReserve: BN; quoteAssetReserve: BN; sqrtK: BN; newPeg: BN } {
	const newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	const dirReserves = calculateSpreadReserves(
		newAmm,
		direction,
		oraclePriceData
	);
	const result = {
		baseAssetReserve: dirReserves.baseAssetReserve,
		quoteAssetReserve: dirReserves.quoteAssetReserve,
		sqrtK: newAmm.sqrtK,
		newPeg: newAmm.pegMultiplier,
	};

	return result;
}

export function calculateBidAskPrice(
	amm: AMM,
	oraclePriceData: OraclePriceData
): [BN, BN] {
	const newAmm = calculateUpdatedAMM(amm, oraclePriceData);
	const askReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.LONG,
		oraclePriceData
	);
	const bidReserves = calculateSpreadReserves(
		newAmm,
		PositionDirection.SHORT,
		oraclePriceData
	);

	const askPrice = calculatePrice(
		askReserves.baseAssetReserve,
		askReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	const bidPrice = calculatePrice(
		bidReserves.baseAssetReserve,
		bidReserves.quoteAssetReserve,
		newAmm.pegMultiplier
	);

	return [bidPrice, askPrice];
}

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetReserves
 * @param quoteAssetReserves
 * @param pegMultiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePrice(
	baseAssetReserves: BN,
	quoteAssetReserves: BN,
	pegMultiplier: BN
): BN {
	if (baseAssetReserves.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetReserves
		.mul(MARK_PRICE_PRECISION)
		.mul(pegMultiplier)
		.div(PEG_PRECISION)
		.div(baseAssetReserves);
}

export type AssetType = 'quote' | 'base';

/**
 * Calculates what the amm reserves would be after swapping a quote or base asset amount.
 *
 * @param amm
 * @param inputAssetType
 * @param swapAmount
 * @param swapDirection
 * @returns quoteAssetReserve and baseAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateAmmReservesAfterSwap(
	amm: Pick<
		AMM,
		'pegMultiplier' | 'quoteAssetReserve' | 'sqrtK' | 'baseAssetReserve'
	>,
	inputAssetType: AssetType,
	swapAmount: BN,
	swapDirection: SwapDirection
): [BN, BN] {
	assert(swapAmount.gte(ZERO), 'swapAmount must be greater than 0');

	let newQuoteAssetReserve;
	let newBaseAssetReserve;

	if (inputAssetType === 'quote') {
		swapAmount = swapAmount
			.mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
			.div(amm.pegMultiplier);

		[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutput(
			amm.quoteAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	} else {
		[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutput(
			amm.baseAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	}

	return [newQuoteAssetReserve, newBaseAssetReserve];
}

export function calculateSpreadBN(
	baseSpread: number,
	lastOracleMarkSpreadPct: BN,
	lastOracleConfPct: BN,
	quoteAssetReserve: BN,
	terminalQuoteAssetReserve: BN,
	pegMultiplier: BN,
	netBaseAssetAmount: BN,
	markPrice: BN,
	totalFeeMinusDistributions: BN
): [number, number] {
	let longSpread = baseSpread / 2;
	let shortSpread = baseSpread / 2;

	if (lastOracleMarkSpreadPct.gt(ZERO)) {
		shortSpread = Math.max(
			shortSpread,
			lastOracleMarkSpreadPct.abs().toNumber() + lastOracleConfPct.toNumber()
		);
	} else if (lastOracleMarkSpreadPct.lt(ZERO)) {
		longSpread = Math.max(
			longSpread,
			lastOracleMarkSpreadPct.abs().toNumber() + lastOracleConfPct.toNumber()
		);
	}

	console.log('JUST ORACLE RETEREAT, ss:', shortSpread, 'ls:', longSpread);

	// inventory skew
	const MAX_INVENTORY_SKEW = 5;
	const netBaseAssetValue = quoteAssetReserve
		.sub(terminalQuoteAssetReserve)
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	const localBaseAssetValue = netBaseAssetAmount
		.mul(markPrice)
		.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));
	console.log(
		'lpnl:',
		localBaseAssetValue.toString(),
		'-',
		netBaseAssetValue.toString()
	);
	let effectiveLeverage = MAX_INVENTORY_SKEW;
	const maxTargetSpread: number = BID_ASK_SPREAD_PRECISION.toNumber() / 50; // 2%

	if (totalFeeMinusDistributions.gt(ZERO)) {
		effectiveLeverage =
			localBaseAssetValue.sub(netBaseAssetValue).toNumber() /
				(totalFeeMinusDistributions.toNumber() + 1) +
			1 / QUOTE_PRECISION.toNumber();

		console.log('effectiveLeverage:', effectiveLeverage);
		let spreadScale = Math.min(MAX_INVENTORY_SKEW, 1 + effectiveLeverage);
		// cap the scale to attempt to only scale up to maxTargetSpread
		// always let the oracle retreat methods go through 100%
		if (netBaseAssetAmount.gt(ZERO)) {
			if (spreadScale * longSpread > maxTargetSpread) {
				spreadScale = Math.max(1.05, maxTargetSpread / longSpread);
			}
			longSpread *= spreadScale;
		} else {
			if (spreadScale * shortSpread > maxTargetSpread) {
				spreadScale = Math.max(1.05, maxTargetSpread / shortSpread);
			}
			shortSpread *= spreadScale;
		}
	} else {
		longSpread *= MAX_INVENTORY_SKEW;
		shortSpread *= MAX_INVENTORY_SKEW;
	}

	return [longSpread, shortSpread];
}

export function calculateSpread(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): number {
	let spread = amm.baseSpread / 2;

	if (amm.baseSpread == 0 || amm.curveUpdateIntensity == 0) {
		return spread;
	}

	const markPrice = calculatePrice(
		amm.baseAssetReserve,
		amm.quoteAssetReserve,
		amm.pegMultiplier
	);

	const targetPrice = oraclePriceData?.price || markPrice;

	const targetMarkSpreadPct = markPrice
		.sub(targetPrice)
		.mul(BID_ASK_SPREAD_PRECISION)
		.div(markPrice);

	console.log('targetMarkSpreadPct:', targetMarkSpreadPct.toString());

	// oracle retreat
	if (
		(isVariant(direction, 'long') && targetMarkSpreadPct.lt(ZERO)) ||
		(isVariant(direction, 'short') && targetMarkSpreadPct.gt(ZERO))
	) {
		spread = Math.max(spread, targetMarkSpreadPct.abs().toNumber());
	}

	// inventory skew
	const MAX_INVENTORY_SKEW = 5;
	if (
		(amm.netBaseAssetAmount.gt(ZERO) && isVariant(direction, 'long')) ||
		(amm.netBaseAssetAmount.lt(ZERO) && isVariant(direction, 'short')) ||
		amm.totalFeeMinusDistributions.eq(ZERO)
	) {
		const netCostBasis = amm.quoteAssetAmountLong.sub(
			amm.quoteAssetAmountShort
		);
		const netBaseAssetValue = amm.quoteAssetReserve
			.sub(amm.terminalQuoteAssetReserve)
			.mul(amm.pegMultiplier)
			.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

		const localBaseAssetValue = amm.netBaseAssetAmount
			.mul(markPrice)
			.div(AMM_TO_QUOTE_PRECISION_RATIO.mul(MARK_PRICE_PRECISION));
		const netPnl = netBaseAssetValue.sub(netCostBasis);
		const localPnl = localBaseAssetValue.sub(netCostBasis);

		let effectiveLeverage = MAX_INVENTORY_SKEW;
		if (amm.totalFeeMinusDistributions.gt(ZERO)) {
			effectiveLeverage =
				localPnl.sub(netPnl).toNumber() /
				(amm.totalFeeMinusDistributions.toNumber() + 1);
		}

		// console.log('effectiveLeverage:', effecstiveLeverage.toString());
		let spreadScale = Math.min(MAX_INVENTORY_SKEW, 1 + effectiveLeverage);
		const maxTargetSpread = BID_ASK_SPREAD_PRECISION.toNumber() / 50; // 2%
		// cap the scale to attempt to only scale up to maxTargetSpread
		// always let the oracle retreat methods go through 100%
		if (spreadScale * spread > maxTargetSpread) {
			spreadScale = Math.max(1.05, maxTargetSpread / spread);
		}

		spread *= spreadScale;
	}

	return spread;
}

export function calculateSpreadReserves(
	amm: AMM,
	direction: PositionDirection,
	oraclePriceData: OraclePriceData
): {
	baseAssetReserve: BN;
	quoteAssetReserve: BN;
} {
	const spread = calculateSpread(amm, direction, oraclePriceData);

	if (spread === 0) {
		return {
			baseAssetReserve: amm.baseAssetReserve,
			quoteAssetReserve: amm.quoteAssetReserve,
		};
	}

	const quoteAsserReserveDelta = amm.quoteAssetReserve.div(
		BID_ASK_SPREAD_PRECISION.div(new BN(spread / 2))
	);

	let quoteAssetReserve;
	if (isVariant(direction, 'long')) {
		quoteAssetReserve = amm.quoteAssetReserve.add(quoteAsserReserveDelta);
	} else {
		quoteAssetReserve = amm.quoteAssetReserve.sub(quoteAsserReserveDelta);
	}

	const baseAssetReserve = amm.sqrtK.mul(amm.sqrtK).div(quoteAssetReserve);
	return {
		baseAssetReserve,
		quoteAssetReserve,
	};
}

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutput(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Translate long/shorting quote/base asset into amm operation
 *
 * @param inputAssetType
 * @param positionDirection
 */
export function getSwapDirection(
	inputAssetType: AssetType,
	positionDirection: PositionDirection
): SwapDirection {
	if (isVariant(positionDirection, 'long') && inputAssetType === 'base') {
		return SwapDirection.REMOVE;
	}

	if (isVariant(positionDirection, 'short') && inputAssetType === 'quote') {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

/**
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: MarketAccount) {
	const directionToClose = market.amm.netBaseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.amm.netBaseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	const terminalPrice = newQuoteAssetReserve
		.mul(MARK_PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN,
	direction: PositionDirection,
	oraclePriceData?: OraclePriceData
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);

	const baseAssetReserveBefore = calculateSpreadReserves(
		amm,
		direction,
		oraclePriceData
	).baseAssetReserve;

	if (newBaseAssetReserve.gt(baseAssetReserveBefore)) {
		return [
			newBaseAssetReserve.sub(baseAssetReserveBefore),
			PositionDirection.SHORT,
		];
	} else if (newBaseAssetReserve.lt(baseAssetReserveBefore)) {
		return [
			baseAssetReserveBefore.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [new BN(0), PositionDirection.LONG];
	}
}

export function calculateQuoteAssetAmountSwapped(
	quoteAssetReserves: BN,
	pegMultiplier: BN,
	swapDirection: SwapDirection
): BN {
	let quoteAssetAmount = quoteAssetReserves
		.mul(pegMultiplier)
		.div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);

	if (isVariant(swapDirection, 'remove')) {
		quoteAssetAmount = quoteAssetAmount.add(ONE);
	}

	return quoteAssetAmount;
}
