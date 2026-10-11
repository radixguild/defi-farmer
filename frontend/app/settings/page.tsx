"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useWallet } from "@/lib/hooks/use-wallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Settings {
  apyDropThreshold: number;
  priceRiskThreshold: number;
  autoCompound: boolean;
  telegramNotifications: boolean;
}

// ⚠ These persist to localStorage and nothing reads them: they are not sent to
// the server and the agent never consults them (REVIEW-2026-07-17 F22). Until
// there is a settings API, a default of `true` here is a claim the product does
// not honour — and the agent is now a non-custodial advisor that never signs,
// so there is no auto-compound to promise at all.
// Default everything to off so the page under-promises rather than lies.
const DEFAULT_SETTINGS: Settings = {
  apyDropThreshold: 15,
  priceRiskThreshold: 10,
  autoCompound: false,
  telegramNotifications: false,
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const stored = localStorage.getItem("defi-farmer-settings");
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // ignore parse errors
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  if (typeof window === "undefined") return;
  localStorage.setItem("defi-farmer-settings", JSON.stringify(settings));
}

function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={disabled ? "Not available yet" : undefined}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? "bg-profit-green" : "bg-muted"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function Separator() {
  return <div className="border-t my-6" />;
}

// Clearly visible in-UI counterpart to the localStorage-only comment above
// (REVIEW-2026-07-17 F22): every control below still writes to the browser
// only, and the agent never reads any of it. State that plainly rather than
// let the working toggles imply otherwise.
function LocalOnlyNotice() {
  return (
    <Card className="border-risk-yellow/40 bg-risk-yellow/5 mb-6">
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-risk-yellow mt-0.5 shrink-0" />
          <p className="text-sm font-medium">
            Preferences are stored locally in this browser and don&apos;t affect the agent yet.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { connected, accounts } = useWallet();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setMounted(true);
  }, []);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    saveSettings(updated);
  };

  if (!mounted) return null;

  return (
    <main className="flex min-h-screen flex-col p-6 md:p-12 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Settings</h1>

      <LocalOnlyNotice />

      {/* Yield Alert Threshold */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Yield Alert Threshold</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Get notified when your earnings rate drops by more than this percentage.
          </p>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              max={100}
              value={settings.apyDropThreshold}
              onChange={(e) =>
                updateSetting("apyDropThreshold", Number(e.target.value) || 15)
              }
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">% drop</span>
          </div>
        </CardContent>
      </Card>

      {/* Price Movement Risk Threshold */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Price Movement Risk Threshold</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Maximum acceptable price movement risk. You&apos;ll be alerted if a position
            exceeds this level.
          </p>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              max={50}
              value={settings.priceRiskThreshold}
              onChange={(e) =>
                updateSetting("priceRiskThreshold", Number(e.target.value) || 10)
              }
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">% max risk</span>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Auto-compound */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">
                Auto-compound earnings
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground align-middle">
                  Coming soon
                </span>
              </p>
              {/* Disabled rather than merely defaulted off: the agent does not
                  read this setting, and defi-farmer is non-custodial — the agent
                  never signs, so there is no automated compounding to enable. An
                  enabled toggle here was a promise the product does not keep (F22). */}
              <p className="text-sm text-muted-foreground">
                defi-farmer is non-custodial: you sign every deposit and withdrawal
                in your own wallet, so there is no automated compounding. Reinvest by
                collecting a position and depositing again when it suits you.
              </p>
            </div>
            <Toggle
              label="Auto-compound earnings"
              checked={settings.autoCompound}
              disabled
              onChange={(v) => updateSetting("autoCompound", v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Telegram Notifications */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Telegram notifications</p>
              <p className="text-sm text-muted-foreground">
                Receive alerts about your positions via Telegram.
              </p>
            </div>
            <Toggle
              checked={settings.telegramNotifications}
              onChange={(v) => updateSetting("telegramNotifications", v)}
            />
          </div>
          {settings.telegramNotifications && (
            <div className="mt-4 rounded-md bg-muted p-4">
              <p className="text-sm font-medium mb-1">Setup Instructions</p>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Open Telegram and search for @DeFiFarmerBot</li>
                <li>Send /start to the bot</li>
                <li>The bot will confirm your connection</li>
              </ol>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Connected Wallet */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Connected Wallet</CardTitle>
        </CardHeader>
        <CardContent>
          {connected && accounts.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Address</span>
                <span className="font-mono text-xs">
                  {accounts[0].address.slice(0, 16)}...{accounts[0].address.slice(-8)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Network</span>
                <span className="text-sm">Radix Mainnet</span>
              </div>
              <Button variant="outline" size="sm" className="w-full mt-2" disabled>
                Disconnect
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Use the Radix Wallet extension to disconnect
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No wallet connected. Connect your Radix wallet to manage settings.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
