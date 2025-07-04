package main

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Settings struct {
	NewsPrompt  string   `yaml:"news_prompt"`
	GrokPrompts []string `yaml:"grok_prompts"`
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
	}
}