// Holds the rails a seller accepts, and answers the two questions the service
// asks: "what should the 402 advertise?" and "which rail owns this payment?".
//
// Routing is by the `(scheme, network)` pair carried on the payer's chosen
// `accepts[]` entry, because that pair is what x402 puts on the wire. The
// service never picks a rail — the payer does, by choosing which entry to sign.

import type { ChallengeRequest, PaymentPayload, PaymentRail, PaymentRequirement, RailInfo, Receipt } from './PaymentRail.ts';
import { PaymentRailError } from './PaymentRail.ts';

const key = (scheme: string, network: string) => `${scheme} ${network}`;

export class RailRegistry {
  readonly rails: readonly PaymentRail[];
  private readonly byKey = new Map<string, PaymentRail>();
  private readonly byId = new Map<string, PaymentRail>();

  constructor(rails: readonly PaymentRail[]) {
    if (rails.length === 0) throw new Error('a seller with no payment rails can never be paid; pass at least one');
    for (const rail of rails) {
      const k = key(rail.info.scheme, rail.info.network);
      const clash = this.byKey.get(k);
      // Two rails on the same (scheme, network) are unroutable: a payment naming
      // that pair could belong to either, and x402 carries nothing else to
      // disambiguate. Fail at construction rather than at settlement.
      if (clash) {
        throw new Error(
          `rails '${clash.id}' and '${rail.id}' both claim scheme ${rail.info.scheme} on ${rail.info.network}; ` +
          'a payment naming that pair would be unroutable',
        );
      }
      if (this.byId.has(rail.id)) throw new Error(`duplicate rail id '${rail.id}'`);
      this.byKey.set(k, rail);
      this.byId.set(rail.id, rail);
    }
    this.rails = [...rails];
  }

  get(id: string): PaymentRail | undefined {
    return this.byId.get(id);
  }

  /** The rail that owns a payer's chosen requirement, or `undefined`. */
  route(requirement: Pick<PaymentRequirement, 'scheme' | 'network'>): PaymentRail | undefined {
    return this.byKey.get(key(requirement.scheme, requirement.network));
  }

  /** As {@link RailRegistry.route}, but throws the error the service turns into a 402. */
  routeOrThrow(payload: PaymentPayload): PaymentRail {
    const rail = this.route(payload.accepted);
    if (!rail) {
      const offered = this.describe().map(r => `${r.scheme}/${r.network}`).join(', ');
      throw new PaymentRailError(
        'registry',
        'unsupported_rail',
        `nothing accepts ${payload.accepted.scheme} on ${payload.accepted.network}; this seller accepts ${offered}`,
      );
    }
    return rail;
  }

  /**
   * Every way to pay, for one resource, at one price.
   *
   * All rails are asked in parallel and **a rail that fails is dropped rather
   * than failing the request** — one unreachable facilitator must not take the
   * whole service down when another rail could still be paid. `accepts` is
   * empty only when every rail failed, which the service turns into a 503.
   */
  async challengeAll(req: ChallengeRequest): Promise<{ accepts: PaymentRequirement[]; failed: { railId: string; error: string }[] }> {
    const settled = await Promise.allSettled(this.rails.map(rail => rail.challenge(req)));
    const accepts: PaymentRequirement[] = [];
    const failed: { railId: string; error: string }[] = [];
    settled.forEach((result, i) => {
      const rail = this.rails[i]!;
      if (result.status === 'fulfilled') accepts.push(result.value);
      else failed.push({ railId: rail.id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    });
    return { accepts, failed };
  }

  /** Look one receipt up across every rail. The audit trail is rail-agnostic. */
  async findReceipt(transaction: string): Promise<Receipt | null> {
    for (const rail of this.rails) {
      const receipt = await rail.receipt(transaction);
      if (receipt) return receipt;
    }
    return null;
  }

  describe(): RailInfo[] {
    return this.rails.map(rail => rail.info);
  }
}
