import { z } from "zod";

export const signupBodySchema = z.object({
  email: z.string().trim().email().max(100),
  password: z.string().min(6).max(255),
  name: z.string().trim().min(1).max(50),
});

export const loginBodySchema = z.object({
  email: z.string().trim().email().max(100),
  password: z.string().min(1).max(255),
});
