import { CAPABILITY_REGISTRY } from '../capabilities.js';
import { EXAMPLE_LIBRARY } from './modules/example-library.js';
import { normalizeEverydayEnglish } from './modules/core-language.js';
import { NegationDetector } from './negation-detector.js';

/**
 * Token-Efficient Knowledge Retriever
 * 
 * Instead of injecting thousands of tokens into Groq prompts,
 * dynamically scores user requests against capabilities and examples,
 * extracting only the 1-3 most relevant capabilities and 1-2 examples (~150 tokens).
 */
export class KnowledgeRetriever {
  /**
   * Retrieves relevant capability metadata and few-shot examples for a prompt.
   * @param {string} prompt Raw user instruction
   * @param {number} maxCapabilities Maximum capabilities to return (default 3)
   * @param {number} maxExamples Maximum examples to return (default 2)
   */
  static retrieve(prompt, maxCapabilities = 3, maxExamples = 2) {
    if (!prompt || typeof prompt !== 'string') {
      return { capabilities: [], examples: [], promptSnippet: '' };
    }

    const normalized = normalizeEverydayEnglish(prompt.toLowerCase());
    const tokens = normalized.split(/\s+/).filter(t => t.length > 2);

    // 1. Score Capabilities
    const capScores = [];
    for (const [action, cap] of Object.entries(CAPABILITY_REGISTRY)) {
      let score = 0;
      const actionTokens = action.toLowerCase().split('_');
      const synTokens = (cap.synonyms || []).join(' ').toLowerCase().split(/\s+/);
      const descTokens = (cap.description || '').toLowerCase().split(/\s+/);

      for (const token of tokens) {
        if (actionTokens.includes(token)) score += 5;
        if (synTokens.includes(token)) score += 3;
        if (descTokens.includes(token)) score += 1;
      }

      if (score > 0) {
        capScores.push({ action, cap, score });
      }
    }

    capScores.sort((a, b) => b.score - a.score);
    const topCaps = capScores.slice(0, maxCapabilities).map(c => ({
      action: c.action,
      category: c.cap.category,
      description: c.cap.description,
      requiredArgs: c.cap.requiredArgs,
      riskLevel: c.cap.riskLevel,
      isReversible: c.cap.isReversible
    }));

    // 2. Score Examples
    const exampleScores = [];
    for (const ex of EXAMPLE_LIBRARY) {
      let score = 0;
      const exWords = ex.utterance.toLowerCase().split(/\s+/);
      for (const token of tokens) {
        if (exWords.includes(token)) score += 2;
      }
      if (topCaps.some(c => c.action === ex.primaryAction)) {
        score += 4;
      }
      if (score > 0) {
        exampleScores.push({ ex, score });
      }
    }

    exampleScores.sort((a, b) => b.score - a.score);
    const topExamples = exampleScores.slice(0, maxExamples).map(e => e.ex);

    // 3. Format compact prompt snippet for LLM injection
    let snippet = '';

    // Check for negative constraints
    const negationInfo = NegationDetector.analyze(prompt);
    if (negationInfo.hasNegation && negationInfo.negatedClauses.length > 0) {
      snippet += `NEGATIVE CONSTRAINTS (DO NOT EXECUTE THESE):\n` +
        negationInfo.negatedClauses.map(c => `- Do NOT perform: "${c}"`).join('\n') + '\n\n';
    }

    if (topCaps.length > 0) {
      snippet += `RELEVANT CAPABILITIES:\n` + topCaps.map(c => 
        `- ${c.action} (${c.category}): ${c.description} [Args: ${(c.requiredArgs || []).join(', ') || 'none'}]`
      ).join('\n') + '\n';
    }

    if (topExamples.length > 0) {
      snippet += `FEW-SHOT EXAMPLES:\n` + topExamples.map(e =>
        `- "${e.utterance}" -> intent: "${e.primaryAction}", args: ${JSON.stringify(e.args || {})}`
      ).join('\n') + '\n';
    }

    return {
      capabilities: topCaps,
      examples: topExamples,
      promptSnippet: snippet.trim()
    };
  }
}
