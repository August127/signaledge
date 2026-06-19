import { z } from "zod";

export const scannerConfigSchema = z.object({
  structureBosAtrBuffer: z.coerce.number().min(0.01).max(0.3).default(0.06),
  spartanP3AtrBuffer: z.coerce.number().min(0.02).max(0.5).default(0.12),
  spartanBreakAtrBuffer: z.coerce.number().min(0.01).max(0.3).default(0.06),
  liquiditySweepAtrBuffer: z.coerce.number().min(0.01).max(0.25).default(0.04),
  crystalBreakAtrBuffer: z.coerce.number().min(0.01).max(0.3).default(0.05),
  volatilityGateAtrPercentile: z.coerce.number().min(0).max(1).default(0.28),
  atrBandMultiplier: z.coerce.number().min(0.5).max(5).default(1.5),
  riskAtrStopMultiplier: z.coerce.number().min(0.5).max(5).default(1.5),
  riskTp1AtrMultiplier: z.coerce.number().min(0.5).max(10).default(2.4),
  riskTp2AtrMultiplier: z.coerce.number().min(0.5).max(15).default(3.5),
});

export const balancedScannerConfig = Object.freeze(scannerConfigSchema.parse({}));

export const productionScannerConfig = Object.freeze(scannerConfigSchema.parse({
  structureBosAtrBuffer: 0.08,
  spartanP3AtrBuffer: 0.16,
  spartanBreakAtrBuffer: 0.08,
  liquiditySweepAtrBuffer: 0.06,
  crystalBreakAtrBuffer: 0.07,
  volatilityGateAtrPercentile: 0.38,
  atrBandMultiplier: 1.8,
}));

export const defaultScannerConfig = productionScannerConfig;

export const scannerConfigPresets = [
  {
    id: "production-conservative",
    name: "Production Conservative",
    description: "Mặc định vận hành sau đánh giá walk-forward: ít nhiễu hơn, ưu tiên A+ có break rõ, volatility đủ lớn và Crystal xác nhận.",
    values: productionScannerConfig,
  },
  {
    id: "balanced",
    name: "Balanced Desk",
    description: "Cân bằng giữa số lượng tín hiệu và độ xác nhận. Dùng khi cần nhiều mã watch hơn.",
    values: balancedScannerConfig,
  },
  {
    id: "conservative",
    name: "Conservative Fund",
    description: "Ít tín hiệu hơn, ưu tiên break rõ và volatility đủ lớn.",
    values: productionScannerConfig,
  },
  {
    id: "aggressive",
    name: "Aggressive Scout",
    description: "Tín hiệu sớm hơn cho scalping/swing ngắn, cần kiểm soát rủi ro chặt.",
    values: {
      ...balancedScannerConfig,
      structureBosAtrBuffer: 0.045,
      spartanP3AtrBuffer: 0.09,
      spartanBreakAtrBuffer: 0.045,
      liquiditySweepAtrBuffer: 0.03,
      crystalBreakAtrBuffer: 0.035,
      volatilityGateAtrPercentile: 0.2,
      atrBandMultiplier: 1.25,
    },
  },
];

export function normalizeScannerConfig(value = {}) {
  return scannerConfigSchema.parse({ ...defaultScannerConfig, ...value });
}
