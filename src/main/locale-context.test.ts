import { beforeEach, describe, expect, it } from "vitest";
import * as locale from "./locale-context";
beforeEach(() => locale.updateLocaleContext({ uiLocale: "zh-CN", dateLocale: "zh-CN", responseLanguage: "zh-CN" }));
const read = () => [locale.getDateLocale(), locale.getWeatherLanguage(), locale.getMemoryLanguage(), locale.getAsrLanguage()];
describe("main-process language preferences", () => {
    it("starts with independent Chinese preferences", () => {
        expect(read()).toEqual(["zh-CN", "zh", "zh-CN", "zh"]);
    });
    it.each(["", "\t \n"])("uses the date default for blank input %j", value => {
        locale.updateLocaleContext({ dateLocale: value });
        expect(locale.getDateLocale()).toEqual("zh-CN");
    });
    it("trims dates without changing service language preferences", () => {
        locale.updateLocaleContext({ dateLocale: "\ten-US\n" });
        expect(read()).toEqual(["en-US", "zh", "zh-CN", "zh"]);
    });
    it.each([
        ["zh-CN", "zh", "zh"], ["en-US", "en", "en"], ["ja-JP", "ja", "en"], ["pt-BR", "en", "en"],
        ["ko-KR", "ko", "en"],
    ])("derives service preferences for %s", (uiLocale, weather, asr) => {
        locale.updateLocaleContext({ uiLocale });
        expect(read()).toEqual(["zh-CN", weather, uiLocale, asr]);
    });
    it("accepts explicit overrides and recomputes them on a later UI change", () => {
        locale.updateLocaleContext({ uiLocale: "ja-JP", weatherLanguage: "ja" });
        expect(locale.getWeatherLanguage()).toEqual("ja");
        locale.updateLocaleContext({ uiLocale: "en-US", asrLanguage: "auto" });
        expect(locale.getAsrLanguage()).toEqual("auto");
        expect(locale.getWeatherLanguage()).toEqual("en");
        locale.updateLocaleContext({ uiLocale: "zh-CN" });
        expect(read()).toEqual(["zh-CN", "zh", "zh-CN", "zh"]);
    });
});
