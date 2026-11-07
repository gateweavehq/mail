import { env } from "cloudflare:workers";
import { limitRecipients } from "../rate-limit";
import { createMailer } from "./mailer";

/** Undefined when email is not configured. */
export const mailer = limitRecipients(createMailer(env.EMAIL, env.EMAIL_FROM || undefined));
