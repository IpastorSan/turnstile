import { Address, Bytes } from "@graphprotocol/graph-ts";
import { Account, ActiveAccount } from "../../generated/schema";

export class AccountResult {
  account: Account;
  isNew: boolean;

  constructor(account: Account, isNew: boolean) {
    this.account = account;
    this.isNew = isNew;
  }
}

export function getOrCreateAccount(address: Address): AccountResult {
  const id = Bytes.fromHexString(address.toHexString());
  let account = Account.load(id);
  if (account != null) {
    return new AccountResult(account, false);
  }

  account = new Account(id);
  account.positionCount = 0;
  account.openPositionCount = 0;
  account.closedPositionCount = 0;
  account.depositCount = 0;
  account.withdrawCount = 0;
  account.swapCount = 0;
  account.save();

  return new AccountResult(account, true);
}

/**
 * ActiveAccount exists only so that "was this address already active in this
 * interval?" is a store lookup rather than a scan. Returns true the first time
 * an account is seen in the given interval.
 */
export function markActive(
  account: Bytes,
  intervalTag: string,
  intervalId: i32
): boolean {
  const id = account.concat(
    Bytes.fromUTF8("-" + intervalTag + "-" + intervalId.toString())
  );
  if (ActiveAccount.load(id) != null) {
    return false;
  }
  const active = new ActiveAccount(id);
  active.save();
  return true;
}
