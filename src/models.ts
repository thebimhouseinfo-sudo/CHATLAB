export type ModelId =
  | 'qwen08-q3'
  | 'qwen08-q4'
  | 'qwen08-astra-q4'
  | 'qwen2-q3'
  | 'qwen2-q4';

export type ModelSpec = {
  id: ModelId;
  name: string;
  family: '0.8B' | '2B';
  flavor: 'original' | 'astra';
  quant: 'Q3_K_M' | 'Q4_K_M';
  repo: string;
  file: string;
  approximateMB: number;
  minimumBytes: number;
  description: string;
};

// Exact filenames are taken from the model repositories. No model weights are bundled.
export const MODELS: readonly ModelSpec[] = [
  {
    id: 'qwen08-q3', name: 'Qwen 0.8B · Lite', family: '0.8B',
    flavor: 'original', quant: 'Q3_K_M', repo: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF',
    file: 'Qwen_Qwen3.5-0.8B-Q3_K_M.gguf', approximateMB: 518,
    minimumBytes: 440_000_000, description: 'Bản gốc · nhỏ nhất trong nhóm so sánh chính',
  },
  {
    id: 'qwen08-q4', name: 'Qwen 0.8B · Base', family: '0.8B',
    flavor: 'original', quant: 'Q4_K_M', repo: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF',
    file: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf', approximateMB: 580,
    minimumBytes: 500_000_000, description: 'Bản gốc Q4 · đối chứng cho Astra',
  },
  {
    id: 'qwen08-astra-q4', name: 'Qwen 0.8B · Astra', family: '0.8B',
    flavor: 'astra', quant: 'Q4_K_M',
    repo: 'NotCherry/Qwen3.5-0.8B-weight-space-programming-GGUF',
    file: 'Qwen3.5-0.8B-Weight-Space-Programming-Q4_K_M.gguf',
    approximateMB: 550, minimumBytes: 450_000_000,
    description: 'Checkpoint Astra weight-space edit · Q4',
  },
  {
    id: 'qwen2-q3', name: 'Qwen 2B · Lite', family: '2B',
    flavor: 'original', quant: 'Q3_K_M', repo: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    file: 'Qwen_Qwen3.5-2B-Q3_K_M.gguf', approximateMB: 1220,
    minimumBytes: 1_050_000_000, description: '2B nén Q3 · ưu tiên RAM thấp',
  },
  {
    id: 'qwen2-q4', name: 'Qwen 2B · Base', family: '2B',
    flavor: 'original', quant: 'Q4_K_M', repo: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    file: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf', approximateMB: 1400,
    minimumBytes: 1_250_000_000, description: '2B Q4 · chất lượng đối chứng',
  },
];

export const modelUrl = (model: ModelSpec): string =>
  'https://huggingface.co/' + model.repo + '/resolve/main/' +
  encodeURIComponent(model.file) + '?download=true';
