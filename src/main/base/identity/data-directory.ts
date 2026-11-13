/**
 * 正式安装版的数据目录名（在 %APPDATA% 下）。
 *
 * 1.2 这一代固定为 Firefly-1.2.0，不随补丁版本号变化：1.2.1 仍用同一目录，补丁升级不丢数据。
 * 1.1.x 的 %APPDATA%\Firefly 不读取、不迁移、不删除（负责人 2026-11-12 决定）。
 * 安装器 build/installer.nsh 写开机自启选项时用同一个目录名，打包配置测试比对两边一致。
 */
export const FIREFLY_DATA_DIRECTORY = "Firefly-1.2.0";
