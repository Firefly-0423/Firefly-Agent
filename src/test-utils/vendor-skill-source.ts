import fs from "node:fs";
import path from "node:path";

export const vendorSkillSource = path.resolve("vendor/firefly-skills/skills");

export function copyVendorSkills(destination: string): void {
  fs.cpSync(vendorSkillSource, destination, { recursive: true, errorOnExist: true });
}
