"use client";

import * as React from "react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

interface SparklineChartProps {
  data: number[];
  color?: "green" | "red" | "neutral";
  className?: string;
}

const colorMap = {
  green: { stroke: "hsl(142, 71%, 45%)", fill: "hsl(142, 71%, 45%)" },
  red: { stroke: "hsl(0, 84%, 60%)", fill: "hsl(0, 84%, 60%)" },
  neutral: { stroke: "hsl(215, 16%, 47%)", fill: "hsl(215, 16%, 47%)" },
};

export function SparklineChart({
  data,
  color = "green",
  className,
}: SparklineChartProps) {
  const chartData = data.map((value, index) => ({ index, value }));
  const colors = colorMap[color];

  return (
    <div className={cn("h-10 w-24", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <YAxis domain={["dataMin", "dataMax"]} hide />
          <Area
            type="monotone"
            dataKey="value"
            stroke={colors.stroke}
            fill={colors.fill}
            fillOpacity={0.15}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
