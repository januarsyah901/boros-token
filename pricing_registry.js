/**
 * Centralized Model Pricing Registry for Boros Token
 * Pricing rates are in USD per 1,000,000 tokens (Standard Industry Rates).
 */

const PRICING_TABLE = {
    // Anthropic Models
    'claude-3-7-sonnet': { input: 3.00, output: 15.00, cache_read: 0.30, provider: 'Anthropic' },
    'claude-3-5-sonnet': { input: 3.00, output: 15.00, cache_read: 0.30, provider: 'Anthropic' },
    'claude-3-opus':     { input: 15.00, output: 75.00, cache_read: 1.50, provider: 'Anthropic' },
    'claude-3-haiku':    { input: 0.25, output: 1.25, cache_read: 0.025, provider: 'Anthropic' },
    'claude-3-5-haiku':  { input: 0.80, output: 4.00, cache_read: 0.08, provider: 'Anthropic' },

    // Google Models
    'gemini-2.5-pro':    { input: 1.25, output: 10.00, cache_read: 0.3125, provider: 'Google' },
    'gemini-2.5-flash':  { input: 0.15, output: 0.60, cache_read: 0.0375, provider: 'Google' },
    'gemini-2.0-flash':  { input: 0.10, output: 0.40, cache_read: 0.025, provider: 'Google' },
    'gemini-1.5-pro':    { input: 1.25, output: 5.00, cache_read: 0.3125, provider: 'Google' },
    'gemini-1.5-flash':  { input: 0.075, output: 0.30, cache_read: 0.01875, provider: 'Google' },

    // OpenAI Models
    'gpt-4o':            { input: 2.50, output: 10.00, cache_read: 1.25, provider: 'OpenAI' },
    'gpt-4o-mini':       { input: 0.15, output: 0.60, cache_read: 0.075, provider: 'OpenAI' },
    'o1':                { input: 15.00, output: 60.00, cache_read: 7.50, provider: 'OpenAI' },
    'o1-mini':           { input: 3.00, output: 12.00, cache_read: 1.50, provider: 'OpenAI' },
    'o3-mini':           { input: 1.10, output: 4.40, cache_read: 0.55, provider: 'OpenAI' },
    'codex-mini':        { input: 1.50, output: 6.00, cache_read: 0.375, provider: 'OpenAI' },
    'gpt-4-turbo':       { input: 10.00, output: 30.00, cache_read: 5.00, provider: 'OpenAI' },

    // xAI Grok Models
    'grok-4.5':          { input: 3.00, output: 15.00, cache_read: 0.75, provider: 'xAI' },
    'grok-4':            { input: 3.00, output: 15.00, cache_read: 0.75, provider: 'xAI' },
    'grok-3':            { input: 2.00, output: 10.00, cache_read: 0.50, provider: 'xAI' },
    'grok-2':            { input: 2.00, output: 10.00, cache_read: 0.50, provider: 'xAI' },

    // DeepSeek Models
    'deepseek-chat':     { input: 0.14, output: 0.28, cache_read: 0.014, provider: 'DeepSeek' },
    'deepseek-reasoner': { input: 0.55, output: 2.19, cache_read: 0.14, provider: 'DeepSeek' },
    'deepseek-v3':       { input: 0.14, output: 0.28, cache_read: 0.014, provider: 'DeepSeek' },
    'deepseek-r1':       { input: 0.55, output: 2.19, cache_read: 0.14, provider: 'DeepSeek' },

    // Fallback default
    'default':           { input: 0.15, output: 0.60, cache_read: 0.0375, provider: 'Generic' }
};

function resolvePricing(modelName) {
    if (!modelName) return PRICING_TABLE['default'];
    const name = String(modelName).trim().toLowerCase();

    // Direct key match
    if (PRICING_TABLE[name]) {
        return PRICING_TABLE[name];
    }

    // Pattern matching
    if (name.includes('opus')) return PRICING_TABLE['claude-3-opus'];
    if (name.includes('sonnet')) {
        if (name.includes('3.7') || name.includes('3-7')) return PRICING_TABLE['claude-3-7-sonnet'];
        return PRICING_TABLE['claude-3-5-sonnet'];
    }
    if (name.includes('haiku')) {
        if (name.includes('3.5') || name.includes('3-5')) return PRICING_TABLE['claude-3-5-haiku'];
        return PRICING_TABLE['claude-3-haiku'];
    }
    if (name.includes('claude')) return PRICING_TABLE['claude-3-5-sonnet'];

    if (name.includes('grok')) {
        if (name.includes('4.5') || name.includes('4-5')) return PRICING_TABLE['grok-4.5'];
        if (name.includes('4')) return PRICING_TABLE['grok-4'];
        if (name.includes('3')) return PRICING_TABLE['grok-3'];
        return PRICING_TABLE['grok-2'];
    }

    if (name.includes('deepseek')) {
        if (name.includes('r1') || name.includes('reasoner')) return PRICING_TABLE['deepseek-reasoner'];
        return PRICING_TABLE['deepseek-chat'];
    }

    if (name.includes('o3-mini')) return PRICING_TABLE['o3-mini'];
    if (name.includes('o1-mini')) return PRICING_TABLE['o1-mini'];
    if (name.includes('o1')) return PRICING_TABLE['o1'];
    if (name.includes('gpt-4o-mini')) return PRICING_TABLE['gpt-4o-mini'];
    if (name.includes('gpt-4o') || name.includes('gpt4o')) return PRICING_TABLE['gpt-4o'];
    if (name.includes('codex')) return PRICING_TABLE['codex-mini'];
    if (name.includes('gpt')) return PRICING_TABLE['gpt-4o-mini'];

    if (name.includes('gemini')) {
        if (name.includes('pro')) {
            if (name.includes('2.5') || name.includes('2-5')) return PRICING_TABLE['gemini-2.5-pro'];
            return PRICING_TABLE['gemini-1.5-pro'];
        }
        if (name.includes('2.5') || name.includes('2-5')) return PRICING_TABLE['gemini-2.5-flash'];
        if (name.includes('2.0') || name.includes('2-0')) return PRICING_TABLE['gemini-2.0-flash'];
        return PRICING_TABLE['gemini-1.5-flash'];
    }

    if (name.includes('flash')) return PRICING_TABLE['gemini-2.5-flash'];
    if (name.includes('pro')) return PRICING_TABLE['gemini-2.5-pro'];

    return PRICING_TABLE['default'];
}

function calculateCost(modelName, inputTokens, outputTokens, cacheTokens) {
    const p = resolvePricing(modelName);
    const inTokens = Math.max(0, Number(inputTokens) || 0);
    const outTokens = Math.max(0, Number(outputTokens) || 0);
    const cTokens = Math.max(0, Number(cacheTokens) || 0);

    const inCost = (inTokens / 1_000_000) * p.input;
    const outCost = (outTokens / 1_000_000) * p.output;
    const cacheCost = (cTokens / 1_000_000) * (p.cache_read || p.input * 0.25);

    const totalCost = inCost + outCost + cacheCost;
    return {
        inputCost: inCost,
        outputCost: outCost,
        cacheCost: cacheCost,
        totalCost: totalCost,
        provider: p.provider,
        rates: p
    };
}

module.exports = {
    PRICING_TABLE,
    resolvePricing,
    calculateCost
};
