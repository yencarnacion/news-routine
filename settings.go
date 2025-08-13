package main

import (
	"os"
	"gopkg.in/yaml.v3"
)

type PplxQuery struct {
	Type        string `yaml:"type"`        // fixed, template, custom
	Prompt      string `yaml:"prompt"`      // for fixed/template
	Placeholder string `yaml:"placeholder"` // for template
	Label       string `yaml:"label"`       // for checkbox
}

type Settings struct {
	NewsPrompt  string      `yaml:"news_prompt"`
	GrokPrompts []string    `yaml:"grok_prompts"`
	PplxQueries []PplxQuery `yaml:"pplx_queries"`
}

func loadSettings() Settings {
	data, err := os.ReadFile("settings.yaml")
	if err != nil {
		return defaultSettings()
	}
	var settings Settings
	err = yaml.Unmarshal(data, &settings)
	if err != nil {
		return defaultSettings()
	}
	return settings
}

func saveSettings(settings Settings) error {
	data, err := yaml.Marshal(settings)
	if err != nil {
		return err
	}
	return os.WriteFile("settings.yaml", data, 0644)
}

func defaultSettings() Settings {
	return Settings{
		NewsPrompt: "The following email contains news from different sources. Each source is indicated by a line in all capital letters, followed by bullet points with news items. Please provide a summary for each source, with the source name in all capital letters, followed by bullet points with the summaries.\n\n",
		GrokPrompts: []string{
			"What are the key stories and trends from recent sources",
			"What are today's headlines",
		},
		PplxQueries: []PplxQuery{
			{Type: "fixed", Prompt: "Prepare me for when markets open today?", Label: "Prepare me for when markets open today?"},
			{Type: "template", Prompt: "Give the main takeaways in markdown about the following: {{context}}. Give your best guess of how the stock will react to this filing from the perspective of a day trader. include the intrument ticker if there is one and you know it.", Placeholder: "context", Label: "Takeaways"},
			{Type: "template", Prompt: "You are an equity news summarizer for short-term traders.\nINPUT: {{page}} (This may include site chrome, menus, and other noise.)\nDATE CONTEXT: Assume “the open” means the next regular U.S. market session after the events in the article.\nTASKS\n1) Parse the article content only (ignore headers, footers, menus, ads). Identify each company mentioned with a clear, company-specific catalyst (earnings, guidance, M&A, regulation, analyst action, operational update, etc.).\n2) For each company, extract:\n   - Company name and instrument ticker (if present or inferable from the text).\n   - The single most important takeaway in 1–2 sentences with key numbers (beats/misses, guidance, deal value, % moves, etc.).\n3) For each company, add a ONE-PARAGRAPH OR SHORTER “Day-Trader Open Read”:\n   - Give your best guess of **how the stock will behave at the next open** in trader terms (e.g., “gap up + possible continuation,” “gap up then fade,” “gap down continuation,” “flat/indecisive”).\n   - Include a one-sentence rationale tied to the catalyst (surprise vs. expectations, quality of guidance, deal math, supply/demand cues).\n   - Keep it concise (≤1–2 sentences). Do NOT give advice or a trade plan; just the likely **directional behavior** and brief reason.\n   - If the ticker is not in the article and cannot be confidently inferred, write “Ticker: n/a”.\nOUTPUT FORMAT (Markdown)\n- Start with: `### Main Takeaways`\n- Then, for each company, use exactly this structure:\n- **<Company Name> (<TICKER or n/a>)**: <1–2 sentence key takeaway with numbers>.\n  _Open read:_ <≤1–2 sentence directional guess at the next open (gap/continuation/fade/flat) + rationale>.\nRULES & STYLE\n- Be definitive but realistic; avoid hedging like “might/maybe” unless uncertainty is material.\n- Prefer the primary U.S.-listed common ticker when multiple classes exist.\n- If an article shows intraday % moves, you may use them as context but still frame the prediction for the **next** open.\n- Keep each “Open read” to one short paragraph or less.\n- Maximum 100 companies. Skip purely macro notes that don’t attach to a specific ticker.", Placeholder: "page", Label: "Equity News Summarizer"},
			{Type: "custom", Label: "Custom query"},
		},
	}
}