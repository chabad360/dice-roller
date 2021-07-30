import { App, PluginSettingTab, Setting } from "obsidian";
import type DiceRoller from "./main";

export default class SettingTab extends PluginSettingTab {
    constructor(app: App, public plugin: DiceRoller) {
        super(app, plugin);
        this.plugin = plugin;
    }
    async display(): Promise<void> {
        let { containerEl } = this;

        containerEl.empty();

        containerEl.createEl("h2", { text: "Dice Roller Settings" });

        new Setting(containerEl)
            .setName("Roll All Files for Tags")
            .setDesc("Return a result for each file when rolling tags.")
            .addToggle((t) => {
                t.setValue(this.plugin.returnAllTags);
                t.onChange(async (v) => {
                    this.plugin.returnAllTags = v;
                    await this.plugin.saveData({
                        returnAllTags: this.plugin.returnAllTags,
                        rollLinksForTags: this.plugin.rollLinksForTags
                    });
                });
            });
        new Setting(containerEl)
            .setName("Always Return Links for Tags")
            .setDesc(
                "Enables random link rolling with the link parameter. Override by specifying a section type."
            )
            .addToggle((t) => {
                t.setValue(this.plugin.rollLinksForTags);
                t.onChange(async (v) => {
                    this.plugin.rollLinksForTags = v;
                    await this.plugin.saveData({
                        returnAllTags: this.plugin.returnAllTags,
                        rollLinksForTags: this.plugin.rollLinksForTags
                    });
                });
            });
    }
}
