/**
 * Per-protocol security posture — restricted to what we can actually back.
 *
 * This table previously asserted specific audit firms and dates for every
 * protocol: "Hash Audit Group" (Ociswap, 2024-Q4), "Hash DAO Audit"
 * (CaviarNine, 2025-Q1), "PeckShield" (DefiPlaza, 2025-Q2), each with a
 * "Read audit" link and a green shield on every card. Checked 2026-07-25:
 *
 *   - https://caviarnine.com/audits  → HTTP 404
 *   - https://defiplaza.net/audits   → HTTP 404
 *   - https://ociswap.com/audits     → HTTP 200 but no audit content
 *
 * None of it was verifiable, and the detailed custody disclosures ("3-of-5
 * multisig", "parameter-update badge") had no source either. Presenting
 * unverified security claims as verified is the most damaging thing this dapp
 * could do, so every such claim is gone.
 *
 * `unverified` is deliberately a THIRD state, distinct from `none`. These
 * protocols may well be audited — we simply have not confirmed it, and
 * claiming "no public audit" would be its own false statement. Only move a
 * protocol to `verified` with a report URL that resolves and names the firm.
 */

/**
 * `protocol-native` is for yield that is part of the Radix protocol itself
 * (validator staking) rather than a deployed contract — there is no third-party
 * contract to audit, so neither "audited" nor "unverified" describes it.
 */
export type AuditStatus =
  | "verified"
  | "unverified"
  | "none"
  | "protocol-native";

export interface AuditInfo {
  status: AuditStatus;
  /** Firm name. Only ever set when status === "verified". */
  auditFirm: string;
  /** Report URL, verified to resolve. Only set when status === "verified". */
  auditUrl: string;
  /** Month/year of the verified audit, e.g. "2026-Q1". */
  auditDate: string;
  /** The protocol's own site, so the user can check for themselves. */
  protocolUrl: string;
  /** What we can and cannot say about admin authority. Written for the user. */
  custodyDisclosure: string;
  protocolLabel: string;
}

const PROTOCOL_AUDITS: Record<string, AuditInfo> = {
  ociswap: {
    status: "unverified",
    auditFirm: "",
    auditUrl: "",
    auditDate: "",
    protocolUrl: "https://ociswap.com",
    custodyDisclosure:
      "We have not verified an audit or admin-key setup for Ociswap. Check with the protocol before depositing.",
    protocolLabel: "Ociswap",
  },
  caviarnine: {
    status: "unverified",
    auditFirm: "",
    auditUrl: "",
    auditDate: "",
    protocolUrl: "https://caviarnine.com",
    custodyDisclosure:
      "We have not verified an audit or admin-key setup for CaviarNine. Check with the protocol before depositing.",
    protocolLabel: "CaviarNine",
  },
  defiplaza: {
    status: "unverified",
    auditFirm: "",
    auditUrl: "",
    auditDate: "",
    protocolUrl: "https://defiplaza.net",
    custodyDisclosure:
      "We have not verified an audit or admin-key setup for DefiPlaza. Check with the protocol before depositing.",
    protocolLabel: "DefiPlaza",
  },
  weft: {
    status: "unverified",
    auditFirm: "",
    auditUrl: "",
    auditDate: "",
    protocolUrl: "https://weft.finance",
    custodyDisclosure:
      "We have not verified an audit or admin-key setup for Weft. Lending markets generally carry upgrade and pause authority — check with the protocol before depositing.",
    protocolLabel: "Weft",
  },
  radix: {
    status: "protocol-native",
    auditFirm: "",
    auditUrl: "",
    auditDate: "",
    protocolUrl: "https://radixdlt.com",
    custodyDisclosure:
      "Native XRD staking is part of the Radix protocol itself, not a smart contract a third party can upgrade or pause. Your stake is delegated to a validator you choose and is unstakeable by you alone, after the network's unstaking delay.",
    protocolLabel: "Radix",
  },
};

const FALLBACK: AuditInfo = {
  status: "unverified",
  auditFirm: "",
  auditUrl: "",
  auditDate: "",
  protocolUrl: "",
  custodyDisclosure:
    "We have no audit or custody information on file for this protocol. Verify directly with the protocol team before depositing.",
  protocolLabel: "",
};

export function getAuditInfo(protocol: string): AuditInfo {
  const key = protocol.toLowerCase();
  const found = PROTOCOL_AUDITS[key];
  if (found) return found;
  return {
    ...FALLBACK,
    protocolLabel: protocol.charAt(0).toUpperCase() + protocol.slice(1),
  };
}

/** True only for a confirmed audit with a resolving report. Currently none. */
export function isAudited(protocol: string): boolean {
  return getAuditInfo(protocol).status === "verified";
}
