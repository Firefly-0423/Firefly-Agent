export type WeatherCategory = "clear" | "cloudy" | "rain" | "snow" | "thunder";
export type WeatherLocation = { city: string; province: string };

export type OpenMeteoWeatherData = {
  pressure: number;
  precipitation: number;
  windSpeed: number;
  windDeg: number;
  humidity: number;
  feelsLike: number;
  temp: number;
  weatherCode: number;
  location: WeatherLocation;
  source: "open-meteo";
};

export type AmapWeatherData = {
  reporttime: string;
  windPower: string;
  windDirection: string;
  humidity: number;
  temp: number;
  weather: string;
  location: WeatherLocation;
  source: "amap";
};

export type WeatherData = OpenMeteoWeatherData | AmapWeatherData;
