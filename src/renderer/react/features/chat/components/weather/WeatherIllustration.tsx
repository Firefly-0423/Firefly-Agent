import React from "react";
import type { WeatherCategory } from "./weather-types";

type WeatherIllustrationProps = { category: WeatherCategory };

export const WeatherIllustration: React.FC<WeatherIllustrationProps> = (props) => (
  <div className={"weather-illustration weather-" + props.category}>
    <div className="sun">
      <div className="sun-rays">{Array.from({ length: 8 }, (_empty, ray) => <span key={ray} />)}</div>
      <div className="sun-core" />
    </div>
    <div className="cloud" />
    <div className="rain">{[0, 1, 2].map((drop) => <span key={drop} />)}</div>
    <div className="snow">{[0, 1, 2].map((flake) => <span key={flake}>❄</span>)}</div>
    <div className="bolt" />
  </div>
);
