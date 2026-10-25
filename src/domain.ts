// Company-domain derivation from a signup email. Free-mail domains tell us
// nothing about the company, so we fall back to the submitted company field.

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "ymail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com",
  "gmx.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com",
  "126.com", "fastmail.com", "hey.com", "tutanota.com", "web.de", "rediffmail.com",
]);

export function emailDomain(email: string): string | undefined {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return undefined;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : undefined;
}

export function isFreeMail(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase());
}

/** Normalise a user-typed domain or URL to a bare hostname without "www.". */
export function normalizeDomain(input: string): string | undefined {
  let s = input.trim().toLowerCase();
  if (!s) return undefined;
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "").replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : undefined;
}

/**
 * The company domain to research, in priority order:
 * 1. the email's domain, unless it's a free-mail provider
 * 2. the company_domain the form submitted
 */
export function companyDomain(email: string, submittedDomain?: string): { domain?: string; source: "email" | "submitted" | "none" } {
  const fromEmail = emailDomain(email);
  if (fromEmail && !isFreeMail(fromEmail)) return { domain: fromEmail.replace(/^www\./, ""), source: "email" };
  const submitted = submittedDomain ? normalizeDomain(submittedDomain) : undefined;
  if (submitted && !isFreeMail(submitted)) return { domain: submitted, source: "submitted" };
  return { source: "none" };
}
