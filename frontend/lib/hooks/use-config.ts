"use client";

import { AppConfig } from "@/lib/types";
import { mockConfig } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

export function useConfig() {
  return useFetch<AppConfig>("/api/config", mockConfig);
}
