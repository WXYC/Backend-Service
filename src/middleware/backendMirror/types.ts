import { Request } from "express";

export type Transform<I, O> = (input: I, req: Request) => O;
export type Backend<O> = (payload: O, req: Request) => Promise<{ status: number; data: unknown }>;
