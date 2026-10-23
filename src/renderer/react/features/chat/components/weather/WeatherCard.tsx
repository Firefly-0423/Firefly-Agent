import React, { useState, useMemo } from "react";
import { useTranslation } from "../../../../i18n";
import type { WeatherData, OpenMeteoWeatherData, AmapWeatherData } from "./weather-types";
import { formatDateText, formatReportTime, omWindDir, mapAmapWeather, mapWmoCode } from "./weather-utils";
import { WeatherIllustration } from "./WeatherIllustration";
import "./weather-card.css";

type WeatherCardProps = { theme?: "light" | "dark"; data: WeatherData };
type SymbolKind = "humidity" | "direction" | "wind" | "precipitation" | "pressure" | "temperature";
const outlines: Record<SymbolKind, string[]> = {
  humidity: ["M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 0 1-13 0C5.5 9.7 12 2.7 12 2.7z"],
  direction: ["M15.5 8.5l-2 5-5 2 2-5z"],
  wind: ["M9.6 4.1A2 2 0 1 1 11 8H2M12.6 19.9A2 2 0 1 0 14 16H2M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2"],
  precipitation: ["M20 16.6A5 5 0 0 0 18 7a7 7 0 1 0-13.9 1.6A4.5 4.5 0 0 0 5.5 17H17", "M8 19v2M12 18v2M16 19v2"],
  pressure: ["M12 15l3.5-3.5", "M20.2 15.5a8.5 8.5 0 1 0-16.4 0"],
  temperature: ["M14 4a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0z"],
};

function WeatherSymbol({ kind }: { kind: SymbolKind }) {
  return <svg strokeLinejoin="round" strokeLinecap="round" strokeWidth="2" stroke="currentColor" fill="none" viewBox="0 0 24 24">
    {kind === "direction" && <circle r="9" cy="12" cx="12" />}
    {outlines[kind].map((outline, index) => <path d={outline} key={index} />)}
  </svg>;
}

function metric(kind: SymbolKind, caption: string, value: React.ReactNode, advanced = false) {
  const prefix = advanced ? "weather-adv" : "weather-detail";
  return <div className={prefix + "-item"}>
    <div className={prefix + "-icon"}><WeatherSymbol kind={kind} /></div>
    <div className={prefix + "-text"}>
      <span className={prefix + "-label"}>{caption}</span>
      <span className={prefix + "-value"}>{value}</span>
    </div>
  </div>;
}

function heading(date: string, updated: React.ReactNode, province: string, city: string, source: string) {
  return <header className="weather-card-header">
    <div className="weather-date-block">
      <span className="weather-date-text">{date}</span>
      <span className="weather-update-text"><span className="weather-update-dot" /><span>{updated}</span></span>
    </div>
    <div className="weather-location">
      <div className="weather-location-row"><span className="weather-province">{province}</span><h1 className="weather-city">{city}</h1></div>
      <span className="weather-source-tag">{source}</span>
    </div>
  </header>;
}

function currentWeather(category: Parameters<typeof WeatherIllustration>[0]["category"], temp: number, description: string, feels: string) {
  return <section className="weather-current">
    <WeatherIllustration category={category} />
    <div className="weather-current-info">
      <div className="weather-temp-row"><span className="weather-temp-value">{temp}</span><span className="weather-temp-unit">°C</span></div>
      <div className="weather-desc">{description}</div><div className="weather-feels-like">{feels}</div>
    </div>
  </section>;
}

export const WeatherCard: React.FC<WeatherCardProps> = ({ data, theme = "light" }) => {
  const { locale } = useTranslation();
  const [detailsVisible, setDetailsVisible] = useState(false);
  const today = useMemo(() => formatDateText(), [locale]);
  return data.source === "open-meteo"
    ? <OpenMeteoCard data={data} theme={theme} dateText={today} advancedOpen={detailsVisible} onToggle={() => setDetailsVisible((before) => !before)} />
    : <AmapCard data={data} theme={theme} dateText={today} />;
};

type OpenMeteoCardProps = {
  onToggle: () => void; advancedOpen: boolean; dateText: string; theme: "light" | "dark"; data: OpenMeteoWeatherData;
};

const OpenMeteoCard: React.FC<OpenMeteoCardProps> = (props) => {
  const { data: reading, theme: palette, dateText: today, advancedOpen: expanded, onToggle: toggle } = props;
  const { t, locale } = useTranslation();
  const [scene, description] = useMemo(() => mapWmoCode(reading.weatherCode), [reading.weatherCode, locale]);
  return <article className={"weather-card " + (expanded ? "advanced-open" : "")} data-theme={palette}>
    {heading(today, t("weather.liveQuery"), reading.location.province, reading.location.city, "Open-Meteo")}
    {currentWeather(scene, reading.temp, description, t("weather.feelsLike", { temp: reading.feelsLike }))}
    <section className="weather-details-grid">
      {metric("humidity", t("weather.humidity"), <>{reading.humidity}%</>)}
      {metric("direction", t("weather.windDirection"), omWindDir(reading.windDeg))}
      {metric("wind", t("weather.windSpeed"), <>{reading.windSpeed} km/h</>)}
      {metric("precipitation", t("weather.precipitation"), <>{reading.precipitation.toFixed(1)} mm</>)}
    </section>
    <button type="button" className="weather-advanced-toggle" aria-expanded={expanded} onClick={toggle}>
      <svg className="weather-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      <span>{expanded ? t("weather.advancedCollapse") : t("weather.advancedExpand")}</span>
      <span className="weather-toggle-hint">{t("weather.advancedHint")}</span>
    </button>
    <div className="weather-advanced-panel"><div className="weather-advanced-panel-inner"><div className="weather-advanced-content">
      {metric("pressure", t("weather.pressure"), <>{reading.pressure.toFixed(1)} hPa</>, true)}
      {metric("temperature", t("weather.feelsLikeTemperature"), <>{reading.feelsLike}°C</>, true)}
    </div></div></div>
    <footer className="weather-card-footer">{t("weather.sourceOpenMeteo")}</footer>
  </article>;
};

type AmapCardProps = { dateText: string; theme: "light" | "dark"; data: AmapWeatherData };

const AmapCard: React.FC<AmapCardProps> = (props) => {
  const { data: reading, theme: palette, dateText: today } = props;
  const { t } = useTranslation();
  const scene = useMemo(() => mapAmapWeather(reading.weather), [reading.weather]);
  return <article className="weather-card" data-theme={palette}>
    {heading(today, formatReportTime(reading.reporttime), reading.location.province, reading.location.city, t("weather.sourceAmapTag"))}
    {currentWeather(scene, reading.temp, reading.weather, t("weather.feelsLike", { temp: reading.temp }))}
    <section className="weather-details-grid three">
      {metric("humidity", t("weather.humidity"), <>{reading.humidity}%</>)}
      {metric("direction", t("weather.windDirection"), t("weather.windDirectionValue", { dir: reading.windDirection }))}
      {metric("wind", t("weather.windPower"), t("weather.windPowerValue", { power: reading.windPower }))}
    </section>
    <footer className="weather-card-footer">{t("weather.sourceAmap")}</footer>
  </article>;
};

export default WeatherCard;
