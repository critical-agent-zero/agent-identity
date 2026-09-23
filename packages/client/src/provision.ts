import { generateKeypair, type Keypair, type RegisterResponse } from "@agent-identity/shared";
import { savePoolProfile } from "./claims.js";
import { AgentIdentityClient } from "./client.js";

export interface ProvisionClientLike {
  register(opts?: { requestedCapabilities?: string[] }): Promise<RegisterResponse>;
}

export interface ProvisionOptions {
  count: number;
  apiUrl: string;
  fleetKey: string;
  base?: string;
  /** Birth grants to ask of the deployment's auto-capabilities policy;
   *  slugs the policy does not list are ignored server-side. */
  requestedCapabilities?: string[];
  makeClient?: (keypair: Keypair) => ProvisionClientLike;
}

export interface ProvisionResult {
  agentId?: string;
  address?: string;
  error?: string;
}

export async function provisionIdentities(opts: ProvisionOptions): Promise<ProvisionResult[]> {
  const makeClient = opts.makeClient
    ?? ((keypair: Keypair) => new AgentIdentityClient({
      apiUrl: opts.apiUrl, keypair, fleetKey: opts.fleetKey,
    }));
  const results: ProvisionResult[] = [];
  for (let i = 0; i < opts.count; i++) {
    const keypair = generateKeypair();
    try {
      const identity = await makeClient(keypair).register(
        opts.requestedCapabilities?.length
          ? { requestedCapabilities: opts.requestedCapabilities }
          : {},
      );
      // The spread records capabilities from the response (when the server
      // sends them) onto the pool profile, so claim-time require checks see
      // policy-granted capabilities without a network read.
      savePoolProfile({ ...keypair, ...identity }, opts.base);
      results.push({ agentId: identity.agentId, address: identity.address });
    } catch (err) {
      results.push({ error: (err as Error).message });
    }
  }
  return results;
}
