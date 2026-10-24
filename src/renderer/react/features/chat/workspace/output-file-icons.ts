import { File, FileCode2, FileImage, FileJson, FileText, type LucideIcon } from "lucide-react";

/** Icons for the sort of file a run produced, shared by the overview's 产出 card and its panel. */
export const OUTPUT_FILE_ICONS: Record<"code" | "text" | "image" | "data" | "other", LucideIcon> = { code: FileCode2, text: FileText, image: FileImage, data: FileJson, other: File };
