import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ERC20 } from "../../generated/Factory/ERC20";
import { Token } from "../../generated/schema";
import { ZERO_BD, ZERO_BI } from "./constants";

/**
 * A handful of mainnet tokens predate the string-returning ERC-20 metadata
 * convention and return bytes32, so `try_symbol` reverts on them. Rather than
 * carry a second ABI, fall back to a static table.
 */
function staticSymbol(address: Address): string | null {
  const hex = address.toHexString();
  if (hex == "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359") return "SAI";
  if (hex == "0xeb9951021698b42e4399f9cbb6267aa35f82d59d") return "LIF";
  if (hex == "0xe0b7927c4af23765cb51314a0e0521a9645f0e2a") return "DGD";
  return null;
}

export function getOrCreateToken(address: Address): Token {
  const id = Bytes.fromHexString(address.toHexString());
  let token = Token.load(id);
  if (token != null) {
    return token;
  }

  token = new Token(id);

  const contract = ERC20.bind(address);

  const symbolResult = contract.try_symbol();
  const staticFallback = staticSymbol(address);
  if (!symbolResult.reverted) {
    token.symbol = symbolResult.value;
  } else if (staticFallback !== null) {
    token.symbol = staticFallback as string;
  } else {
    token.symbol = "UNKNOWN";
  }

  const nameResult = contract.try_name();
  token.name = nameResult.reverted ? token.symbol : nameResult.value;

  const decimalsResult = contract.try_decimals();
  token.decimals = decimalsResult.reverted ? 18 : decimalsResult.value;

  const supplyResult = contract.try_totalSupply();
  token._totalSupply = supplyResult.reverted ? ZERO_BI : supplyResult.value;

  token.lastPriceUSD = ZERO_BD;
  token.lastPriceBlockNumber = ZERO_BI;
  token._totalValueLockedUSD = ZERO_BD;
  token._largePriceChangeBuffer = 0;
  token._largeTVLImpactBuffer = 0;
  token.save();

  return token;
}

export function tokenBalanceOf(token: Token, holder: Address): BigInt {
  const contract = ERC20.bind(Address.fromBytes(token.id));
  const result = contract.try_balanceOf(holder);
  return result.reverted ? ZERO_BI : result.value;
}
