const encoder = new TextEncoder();

interface SESConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fromAddress: string;
}

export async function sendMagicLinkEmail(
  cfg: SESConfig,
  toEmail: string,
  verifyUrl: string,
): Promise<void> {
  const subject = "Your Chatcode sign-in link";
  const text = [
    "Use this sign-in link:",
    "",
    verifyUrl,
    "",
    "This link expires in 10 minutes.",
  ].join("\n");

  await sendSESEmail(cfg, toEmail, subject, text);
}

async function sendSESEmail(
  cfg: SESConfig,
  toEmail: string,
  subject: string,
  textBody: string,
): Promise<void> {
  const method = "POST";
  const service = "ses";
  const host = `email.${cfg.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";

  const bodyParams = new URLSearchParams({
    Action: "SendEmail",
    Version: "2010-12-01",
    Source: cfg.fromAddress,
    "Destination.ToAddresses.member.1": toEmail,
    "Message.Subject.Data": subject,
    "Message.Body.Text.Data": textBody,
    "Message.Subject.Charset": "UTF-8",
    "Message.Body.Text.Charset": "UTF-8",
  });
  const body = bodyParams.toString();

  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const payloadHash = await sha256Hex(body);
  const canonicalRequest = [
    method,
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(
    cfg.secretAccessKey,
    dateStamp,
    cfg.region,
    service,
  );
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(endpoint, {
    method,
    headers: {
      "Content-Type": contentType,
      "X-Amz-Date": amzDate,
      Authorization: authorization,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SES SendEmail failed: ${resp.status} ${text}`);
  }
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toAmzDate(date: Date): string {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return iso.endsWith("Z") ? iso : `${iso}Z`;
}
