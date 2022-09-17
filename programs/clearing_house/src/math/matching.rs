use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::MARK_PRICE_PRECISION_I128;
use crate::math_error;
use crate::state::user::Order;
use solana_program::msg;
use std::cmp::min;

pub fn is_maker_for_taker(maker_order: &Order, taker_order: &Order) -> ClearingHouseResult<bool> {
    if taker_order.post_only {
        Err(ErrorCode::CantMatchTwoPostOnlys)
    } else if maker_order.post_only && !taker_order.post_only {
        Ok(true)
    } else {
        Ok(maker_order.ts < taker_order.ts)
    }
}

pub fn are_orders_same_market_but_different_sides(
    maker_order: &Order,
    taker_order: &Order,
) -> bool {
    maker_order.market_index == taker_order.market_index
        && maker_order.direction != taker_order.direction
}

pub fn do_orders_cross(
    maker_direction: &PositionDirection,
    maker_price: u128,
    taker_price: u128,
) -> bool {
    match maker_direction {
        PositionDirection::Long => taker_price <= maker_price,
        PositionDirection::Short => taker_price >= maker_price,
    }
}

pub fn calculate_fill_for_matched_orders(
    maker_base_asset_amount: u128,
    maker_price: u128,
    taker_base_asset_amount: u128,
    base_precision: u32,
) -> ClearingHouseResult<(u128, u128)> {
    let base_asset_amount = min(maker_base_asset_amount, taker_base_asset_amount);

    let precision_decrease = 10_u128.pow(10 + base_precision - 6);

    let quote_asset_amount = base_asset_amount
        .checked_mul(maker_price)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_filler_multiplier_for_matched_orders(
    maker_price: u128,
    maker_direction: &PositionDirection,
    oracle_price: i128,
) -> ClearingHouseResult<u128> {
    // percentage oracle_price is above maker_price
    let price_pct_diff = oracle_price
        .checked_sub(cast_to_i128(maker_price)?)
        .ok_or_else(math_error!())?
        .checked_mul(MARK_PRICE_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let ten_bps_pct_diff = MARK_PRICE_PRECISION_I128 / 1000;

    // offer filler multiplier based on price improvement from reasonable baseline
    let multiplier = match maker_direction {
        PositionDirection::Long => (-price_pct_diff + ten_bps_pct_diff),
        PositionDirection::Short => (price_pct_diff - ten_bps_pct_diff),
    }
    .min(ten_bps_pct_diff);

    Ok(cast_to_u128(multiplier)?)
}
