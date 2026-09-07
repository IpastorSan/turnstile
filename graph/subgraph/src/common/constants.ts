import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";

// --- Messari protocol descriptors -------------------------------------------
// These land verbatim on DexAmmProtocol. `schemaVersion` is the version of the
// standardized schema this subgraph implements and is the field a consumer
// checks before assuming a query will run.
export const PROTOCOL_NAME = "Uniswap v3";
export const PROTOCOL_SLUG = "uniswap-v3";
export const PROTOCOL_SCHEMA_VERSION = "4.0.1";
export const PROTOCOL_SUBGRAPH_VERSION = "1.0.0";
export const PROTOCOL_METHODOLOGY_VERSION = "1.0.0";
export const PROTOCOL_NETWORK = "MAINNET";
export const PROTOCOL_TYPE = "EXCHANGE";

export const TOKEN_TYPE_ERC20 = "ERC20";

export const FEE_TYPE_FIXED_TRADING = "FIXED_TRADING_FEE";
export const FEE_TYPE_FIXED_LP = "FIXED_LP_FEE";
export const FEE_TYPE_FIXED_PROTOCOL = "FIXED_PROTOCOL_FEE";

// --- Contracts ---------------------------------------------------------------
export const FACTORY_ADDRESS = Address.fromString(
  "0x1f98431c8ad98523631ae4a59f267346ea31f984"
);
export const POSITION_MANAGER_ADDRESS = Address.fromString(
  "0xc36442b4a4522e871399cd717abdd847ab11fe88"
);

export const WETH_ADDRESS = Address.fromString(
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
);
// The reference pool for ETH/USD. Deep, and it swaps in nearly every block, so
// the cached ETH price is never far from the chainhead.
export const USDC_WETH_005_POOL = Address.fromString(
  "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"
);

export const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const USDT_ADDRESS = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const DAI_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f";

export const STABLECOINS: string[] = [
  USDC_ADDRESS,
  USDT_ADDRESS,
  DAI_ADDRESS,
  "0x4fabb145d64652a948d72533023f6e7a623c7c53", // BUSD
  "0x853d955acef822db058eb8505911ed77f175b99e", // FRAX
  "0x0000000000085d4780b73119b644ae5ecd22b376", // TUSD
  "0x8e870d67f660d95d5be530380d0ec0bd388289e1", // USDP
  "0x6c3ea9036406852006290770bedfcaba0e23a0e8", // PYUSD
];

// --- Numeric ------------------------------------------------------------------
export const ZERO_I32 = 0 as i32;
export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const TWO_BI = BigInt.fromI32(2);
export const ZERO_BD = BigDecimal.fromString("0");
export const ONE_BD = BigDecimal.fromString("1");
export const HUNDRED_BD = BigDecimal.fromString("100");

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;

// 2^192, the denominator when squaring a Q64.96 sqrt price.
export const Q192 = BigInt.fromI32(2).pow(192);

// Uniswap v3 fee tiers are hundredths of a bip: 3000 == 0.30%.
export const FEE_DENOMINATOR = BigDecimal.fromString("10000");

// --- Helper store keys --------------------------------------------------------
export const ETH_PRICE_KEY = Bytes.fromUTF8("ETH_PRICE_USD");
