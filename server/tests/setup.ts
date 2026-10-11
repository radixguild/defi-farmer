/// Test environment setup — provides dummy env vars so CONFIG doesn't throw.
/// Loaded via bunfig.toml preload before any test file runs.
///
/// Non-custodial: the only REQUIRED env var is API_AUTH_TOKEN (no signing key,
/// vault, or account — the agent never signs).
process.env.API_AUTH_TOKEN ??= 'test-token-for-ci';
/// One allowlisted operator wallet, so the operator tier's session route
/// (F10/F14/F17) is exercised. CONFIG caches on first access, so this must be
/// set here in the preload rather than inside a test.
process.env.OPERATOR_ADDRESSES ??=
  'account_rdx12yr8ftvsw7d0nmsxjmxu5nsdwqpwd6y5xk88fjqjhrp8v0hjhcplvw';
/// A test-only PlazaPair package pin (DF-1). No DefiPlaza package is recorded
/// as verified in docs/DEX-INTEGRATION.md, so without this every PlazaPair
/// fixture resolves as 'unsupported'. Also exercises the env-extension path
/// of config.parseDexPackagePins end to end. Never a real address.
process.env.DEX_PACKAGES_DEFIPLAZA_PAIR ??=
  'package_rdx1testonlyplazapairpin0000000000000000000000000000000';
/// Test-only BasicPool and WeightedPool pins, for the same reason: neither kind
/// has a package pinned in code, so without these buildAndPreview cannot be
/// driven end to end for them against a stubbed Gateway
/// (dex-build-service.test.ts). Never real addresses.
process.env.DEX_PACKAGES_OCISWAP_BASIC ??=
  'package_rdx1testonlybasicpoolpin0000000000000000000000000000000';
process.env.DEX_PACKAGES_CAVIARNINE_WEIGHTED ??=
  'package_rdx1testonlyweightedpoolpin0000000000000000000000000000';
