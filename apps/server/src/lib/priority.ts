import { z } from "zod";
import { TASK_PRIORITY_INPUTS, normalizePriority } from "@sag/shared";

/** A task priority in a request body: LOW / MEDIUM / HIGH / CRITICAL (URGENT still accepted and stored as CRITICAL). */
export const priorityInput = z.enum(TASK_PRIORITY_INPUTS).transform(normalizePriority);
