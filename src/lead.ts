import { z } from "zod";

export const SignupEventSchema = z.object({
  event_id: z.string().min(1).max(200),
  email: z.email(),
  name: z.string().max(200).optional(),
  company_name: z.string().max(200).optional(),
  company_domain: z.string().max(253).optional(),
  source: z.enum(["signup", "demo_booking", "calendly", "manual"]).default("signup"),
});

export type SignupEvent = z.infer<typeof SignupEventSchema>;

/** Demo bookings get a Slack alert even when enrichment couldn't run. */
export function isDemoBooking(e: SignupEvent): boolean {
  return e.source === "demo_booking" || e.source === "calendly";
}
