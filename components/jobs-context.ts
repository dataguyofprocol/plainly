"use client";

import { createContext } from "react";
import type { JobRecord } from "@/src/core";

export const JobsContext = createContext<JobRecord[]>([]);
