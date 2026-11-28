import qr from "qr-image";

export async function createQrDataUrl(content: string, size = 256): Promise<string> {
  const stream = qr.image(content, { type: "png", ec_level: "M", margin: 2, size });
  const buffers: Buffer[] = [];
  for await (const bytes of stream) buffers.push(Buffer.from(bytes));
  const image = Buffer.concat(buffers);
  return `data:image/png;base64,${image.toString("base64")}`;
}
export async function createQrSvg(content: string): Promise<string> {
  const stream = qr.image(content, { type: "svg", ec_level: "M", margin: 2 });
  const buffers: Buffer[] = [];
  for await (const bytes of stream) buffers.push(Buffer.from(bytes));
  return Buffer.concat(buffers).toString("utf8");
}
