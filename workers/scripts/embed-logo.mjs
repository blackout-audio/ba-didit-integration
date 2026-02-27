import { readFileSync, writeFileSync } from "node:fs";

const sourcePath =
  "C:/Users/morsk/.cursor/projects/c-Users-morsk-Desktop-Claude-Code-BA-Didit-Integration/assets/c__Users_morsk_AppData_Roaming_Cursor_User_workspaceStorage_9096186b9c0a6374589ddf59cb10542b_images_Black_text_with_padding-3ce45f24-e094-4aa8-ad96-35f11f575b27.png";
const outputPath = "workers/src/logo.ts";

const base64 = readFileSync(sourcePath).toString("base64");
const output = `export const BLACKOUT_LOGO_DATA_URI = "data:image/png;base64,${base64}";\n`;
writeFileSync(outputPath, output, "utf8");

console.log(`Wrote ${outputPath} (${output.length} chars)`);
