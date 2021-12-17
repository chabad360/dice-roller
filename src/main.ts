import {
    Plugin,
    MarkdownPostProcessorContext,
    Notice,
    addIcon,
    MarkdownView,
    TFile,
    WorkspaceLeaf
} from "obsidian";

import type { Plugins } from "../../obsidian-overload/index";

//@ts-ignore
import lexer from "lex";

import { faDice } from "@fortawesome/free-solid-svg-icons";
import { faCopy } from "@fortawesome/free-regular-svg-icons";
import { icon } from "@fortawesome/fontawesome-svg-core";

import { Parser } from "./parser/parser";
import { Conditional, Lexeme } from "src/types";

import { around } from "monkey-around";
import { decode } from "he";

import {
    CONDITIONAL_REGEX,
    COPY_DEFINITION,
    DICE_REGEX,
    ICON_DEFINITION,
    MATH_REGEX,
    OMITTED_REGEX,
    SECTION_REGEX,
    TABLE_REGEX,
    TAG_REGEX
} from "./utils/constants";
import {
    StackRoller,
    TableRoller,
    SectionRoller,
    TagRoller,
    LinkRoller,
    LineRoller
} from "./roller";

import SettingTab from "./settings/settings";

import { BasicRoller } from "./roller/roller";
import DiceView, { VIEW_TYPE } from "./view/view";
import DiceRenderer from "./view/renderer";

import {
    Decoration,
    DecorationSet,
    EditorView,
    MatchDecorator,
    ViewPlugin,
    ViewUpdate,
    WidgetType
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { tokenClassNodeProp } from "@codemirror/stream-parser";
import { RangeSetBuilder } from "@codemirror/rangeset";

String.prototype.matchAll =
    String.prototype.matchAll ||
    function* matchAll(regexp: RegExp): IterableIterator<RegExpMatchArray> {
        const flags = regexp.global ? regexp.flags : regexp.flags + "g";
        const re = new RegExp(regexp, flags);
        let match;
        while ((match = re.exec(this))) {
            yield match;
        }
    };

//expose dataview plugin for tags
declare module "obsidian" {
    interface App {
        plugins: {
            getPlugin<T extends keyof Plugins>(plugin: T): Plugins[T];
        };
    }
    interface Workspace {
        on(name: "dice-roller:update-colors", callback: () => void): EventRef;
        on(
            name: "dice-roller:render-dice",
            callback: (roll: string) => void
        ): EventRef;
        on(
            name: "dice-roller:rendered-result",
            callback: (result: number) => void
        ): EventRef;
    }
    interface MetadataCache {
        on(name: "dataview:api-ready", callback: () => void): EventRef;
    }
}

declare global {
    interface Window {
        __THREE__: string;
    }
}
interface DiceRollerSettings {
    returnAllTags: boolean;
    rollLinksForTags: boolean;
    copyContentButton: boolean;
    displayResultsInline: boolean;
    displayLookupRoll: boolean;
    displayFormulaForMod: boolean;
    formulas: Record<string, string>;
    persistResults: boolean;

    showDice: boolean;
    results: {
        [path: string]: {
            [line: string]: {
                [index: string]: Record<string, any>;
            };
        };
    };
    defaultRoll: number;
    defaultFace: number;
    renderer: boolean;
    diceColor: string;
    textColor: string;
    showLeafOnStartup: boolean;
    customFormulas: string[];
}

const DEFAULT_SETTINGS: DiceRollerSettings = {
    returnAllTags: true,
    rollLinksForTags: false,
    copyContentButton: true,
    customFormulas: [],
    displayFormulaForMod: true,
    displayResultsInline: false,
    displayLookupRoll: true,
    formulas: {},
    persistResults: false,
    results: {},
    defaultRoll: 1,
    defaultFace: 100,
    renderer: false,
    diceColor: "#202020",
    textColor: "#ffffff",
    showLeafOnStartup: true,
    showDice: true
};

export default class DiceRollerPlugin extends Plugin {
    lexer: lexer;
    parser: Parser;
    data: DiceRollerSettings;

    renderer: DiceRenderer;

    persistingFiles: Set<string> = new Set();

    fileMap: Map<TFile, BasicRoller[]> = new Map();

    get canUseDataview() {
        return this.app.plugins.getPlugin("dataview") != null;
    }
    get dataview() {
        return this.app.plugins.getPlugin("dataview");
    }
    async dataviewReady() {
        return new Promise((resolve) => {
            if (!this.canUseDataview) resolve(false);
            if (this.dataview.api) {
                resolve(true);
            }
            this.registerEvent(
                this.app.metadataCache.on("dataview:api-ready", () => {
                    resolve(true);
                })
            );
        });
    }

    get view() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        const leaf = leaves.length ? leaves[0] : null;
        if (leaf && leaf.view && leaf.view instanceof DiceView)
            return leaf.view;
    }
    async addDiceView(startup = false) {
        if (startup && !this.data.showLeafOnStartup) return;
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) {
            return;
        }
        await this.app.workspace.getRightLeaf(false).setViewState({
            type: VIEW_TYPE
        });
        /* this.app.workspace.revealLeaf(this.view.leaf); */
    }

    inline: Map<string, number> = new Map();

    async registerDataviewInlineFields() {
        if (!this.canUseDataview) return;

        await this.dataviewReady();

        const pages = this.dataview.index.pages;

        pages.forEach(({ fields }) => {
            for (const [key, value] of fields) {
                if (
                    typeof value !== "number" ||
                    Number.isNaN(value) ||
                    value == undefined
                )
                    continue;
                this.inline.set(key, value);
            }
        });

        this.registerEvent(
            this.dataview.index.events.on(
                "dataview:metadata-change",
                (type, file) => {
                    if (type === "update") {
                        const page = this.dataview.api.page(file.path);

                        if (!page) return;

                        for (let key in page) {
                            let value = page[key];
                            if (
                                typeof value !== "number" ||
                                Number.isNaN(value) ||
                                value == undefined
                            )
                                continue;
                            this.inline.set(key, value);
                        }
                    }
                }
            )
        );
    }

    async renderRoll(roller: StackRoller) {
        this.addChild(this.renderer);
        this.renderer.setDice(roller);

        await this.renderer.start();

        roller.recalculate();
    }

    async onload() {
        console.log("DiceRoller plugin loaded");
        this.data = Object.assign(DEFAULT_SETTINGS, await this.loadData());

        this.renderer = new DiceRenderer(this);

        this.addSettingTab(new SettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new DiceView(this, leaf)
        );
        this.app.workspace.onLayoutReady(() => this.addDiceView(true));

        this.addCommands();
        this.addIcons();

        this.registerEvents();
        this.registerMarkdownPostProcessor((el, ctx) =>
            this.postprocess(el, ctx)
        );

        this.buildLexer();
        this.buildParser();
        this.app.workspace.onLayoutReady(async () => {
            await this.registerDataviewInlineFields();
        });

        const ext = this.getLivePostprocessor();
        this.registerEditorExtension(ext);
    }
    getLivePostprocessor() {
        const plugin = this;

        class DiceWidget extends WidgetType {
            constructor(public roller: StackRoller) {
                super();
            }
            toDOM(view: EditorView): HTMLElement {
                return this.roller.containerEl;
            }
            eq(other: DiceWidget) {
                /** NEVER REPLACE - CAUSES REROLL! */
                return true;
            }
            ignoreEvent() {
                return false;
            }
            destroy(dom: HTMLElement): void {
                console.log("destroy-widget");
            }
        }

        class LivePlugin {
            decorations: DecorationSet;
            constructor(view: EditorView) {
                this.build(view);
            }
            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged) {
                    //rebuild
                    this.build(update.view);
                } else if (update.selectionSet) {
                    const transactions = update.transactions.filter(
                        (t) => t.selection
                    );
                    if (!transactions) return;
                    for (const transaction of transactions) {
                        for (const range of transaction.selection.ranges) {
                            this.decorations.between(
                                range.from,
                                range.to,
                                (from, to, decoration) => {
                                    //each decoration has a selection range in it
                                }
                            );
                        }
                    }
                }
            }
            destroy(): void {
                console.log("destroy-plugin");
            }
            build(view: EditorView) {
                let builder = new RangeSetBuilder<Decoration>();
                for (let { from, to } of view.visibleRanges) {
                    syntaxTree(view.state).iterate({
                        from,
                        to,
                        enter: (type, from, to) => {
                            const tokens = type.prop(tokenClassNodeProp);
                            const props = new Set(tokens?.split(" "));

                            if (!props.has("inline-code")) return;
                            if (props.has("formatting")) return;
                            const line = view.state.doc.sliceString(from, to);
                            if (!/^dice:/.test(line)) return;

                            const [, dice] = line.match(/^dice:\s?(.+)/) ?? [];
                            if (!dice?.trim().length) return;
                            const roller = plugin.getRoller<StackRoller>(
                                dice,
                                "live-preview"
                            );

                            let deco = Decoration.replace({
                                widget: new DiceWidget(roller),
                                from,
                                to
                            });
                            roller.roll();
                            builder.add(from - 1, to + 1, deco);
                        }
                    });
                }
                this.decorations = builder.finish();
            }
        }

        return ViewPlugin.fromClass(LivePlugin, {
            decorations: (v) => v.decorations
        });
    }
    async postprocess(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        let nodeList = el.querySelectorAll("code");

        if (!nodeList.length) return;

        const path = ctx.sourcePath;
        const info = ctx.getSectionInfo(el);
        const lineStart = ctx.getSectionInfo(el)?.lineStart;
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);

        if (!file || !(file instanceof TFile)) return;

        const toPersist: Record<number, BasicRoller> = {};

        for (let index = 0; index < nodeList.length; index++) {
            const node = nodeList.item(index);

            if (/^dice\-mod:\s*([\s\S]+)\s*?/.test(node.innerText) && info) {
                try {
                    let [full, content] = node.innerText.match(
                        /^dice\-mod:\s*([\s\S]+)\s*?/
                    );
                    if (!DICE_REGEX.test(content)) {
                        new Notice(
                            "Replacing note content may only be done with Dice Rolls."
                        );
                        continue;
                    }

                    const showFormula =
                        !content.includes("|noform") ??
                        this.data.displayFormulaForMod;

                    content = content.replace("|noform", "");

                    //build result map;
                    const roller = this.getRoller(content, ctx.sourcePath);

                    await roller.roll();

                    const fileContent = (
                        await this.app.vault.cachedRead(file)
                    ).split("\n");
                    let splitContent = fileContent.slice(
                        info.lineStart,
                        info.lineEnd + 1
                    );

                    const rep = showFormula
                        ? `${roller.inlineText} **${roller.result}**`
                        : `**${roller.result}**`;

                    splitContent = splitContent
                        .join("\n")
                        .replace(`\`${full}\``, rep)
                        .split("\n");

                    fileContent.splice(
                        info.lineStart,
                        info.lineEnd - info.lineStart + 1,
                        ...splitContent
                    );

                    await this.app.vault.modify(file, fileContent.join("\n"));
                    continue;
                } catch (e) {
                    console.error(e);
                }
            }
            if (!/^dice(?:\+|\-|\-mod)?:\s*([\s\S]+)\s*?/.test(node.innerText))
                continue;
            try {
                let [, content] = node.innerText.match(
                    /^dice(?:\+|\-|\-mod)?:\s*([\s\S]+)\s*?/
                );

                //build result map;
                const roller = this.getRoller(content, ctx.sourcePath);

                const load = async () => {
                    await roller.roll();

                    if (
                        (this.data.persistResults &&
                            !/dice\-/.test(node.innerText)) ||
                        /dice\+/.test(node.innerText)
                    ) {
                        this.persistingFiles.add(ctx.sourcePath);
                        toPersist[index] = roller;
                        roller.save = true;
                        const result =
                            this.data.results?.[path]?.[lineStart]?.[index] ??
                            null;
                        if (result) {
                            await roller.applyResult(result);
                        }
                    }

                    node.replaceWith(roller.containerEl);
                };

                if (roller.loaded) {
                    await load();
                } else {
                    roller.on("loaded", async () => {
                        await load();
                    });
                }

                if (!this.fileMap.has(file)) {
                    this.fileMap.set(file, []);
                }
                this.fileMap.set(file, [...this.fileMap.get(file), roller]);

                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (
                    view &&
                    this.fileMap.has(file) &&
                    this.fileMap.get(file).length === 1
                ) {
                    const self = this;

                    let unregisterOnUnloadFile = around(view, {
                        onUnloadFile: function (next) {
                            return async function (unloaded: TFile) {
                                if (unloaded == file) {
                                    self.fileMap.delete(file);
                                    unregisterOnUnloadFile();
                                }

                                return await next.call(this, unloaded);
                            };
                        }
                    });
                    view.register(unregisterOnUnloadFile);
                    view.register(() => this.fileMap.delete(file));
                }
            } catch (e) {
                console.error(e);
                new Notice(
                    `There was an error parsing the dice string: ${node.innerText}.\n\n${e}`,
                    5000
                );
                continue;
            }
        }

        if (path in this.data.results) {
            this.data.results[path][lineStart] = {};
        }

        //this needs to be asynchronous
        if (Object.entries(toPersist).length) {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) {
                const self = this;
                let unregisterOnUnloadFile = around(view, {
                    onUnloadFile: function (next) {
                        return async function (unloaded: TFile) {
                            if ((unloaded = file)) {
                                if (self.persistingFiles.has(path)) {
                                    self.persistingFiles.delete(path);
                                    self.data.results[path] = {};
                                }

                                for (let index in toPersist) {
                                    const roller = toPersist[index];
                                    const newLineStart =
                                        ctx.getSectionInfo(el)?.lineStart;

                                    if (newLineStart == null) continue;

                                    const result = {
                                        [newLineStart]: {
                                            ...(self.data.results[path]?.[
                                                newLineStart
                                            ] ?? {}),
                                            [index]: roller.toResult()
                                        }
                                    };

                                    self.data.results[path] = {
                                        ...(self.data.results[path] ?? {}),
                                        ...result
                                    };

                                    await self.saveSettings();
                                }
                            }
                            unregisterOnUnloadFile();
                            return await next.call(this, unloaded);
                        };
                    }
                });
                view.register(unregisterOnUnloadFile);
                view.register(async () => {
                    if (this.persistingFiles.has(path)) {
                        this.persistingFiles.delete(path);
                        this.data.results[path] = {};
                    }
                    for (let index in toPersist) {
                        const roller = toPersist[index];
                        const newLineStart = ctx.getSectionInfo(el)?.lineStart;

                        if (newLineStart == null) continue;

                        const result = {
                            [newLineStart]: {
                                ...(this.data.results[path]?.[newLineStart] ??
                                    {}),
                                [index]: roller.toResult()
                            }
                        };

                        this.data.results[path] = {
                            ...(this.data.results[path] ?? {}),
                            ...result
                        };

                        await this.saveSettings();
                    }
                });
            }
        }
    }

    public async parseDice(content: string, source: string) {
        const roller = this.getRoller(content, source);
        return { result: await roller.roll(), roller };
    }
    clearEmpties(o: Record<any, any>) {
        for (var k in o) {
            if (!o[k] || typeof o[k] !== "object") {
                continue;
            }

            this.clearEmpties(o[k]);
            if (Object.keys(o[k]).length === 0) {
                delete o[k];
            }
        }
    }

    async saveSettings() {
        this.clearEmpties(this.data.results);

        await this.saveData(this.data);
    }
    get dataview_regex(): RegExp {
        const fields = Array.from(this.inline.keys());

        if (!fields.length) return null;

        return new RegExp(`(${fields.join("|")})`, "g");
    }
    getRoller<T extends BasicRoller>(
        content: string,
        source: string,
        icon?: boolean
    ): T;
    getRoller(
        content: string,
        source: string,
        icon = this.data.showDice
    ): BasicRoller {
        let showDice = content.includes("|nodice") ? false : icon;

        content = decode(
            content
                .replace(/^dice:/, "")
                .replace("|nodice", "")
                .replace("\\|", "|")
        );

        if (content in this.data.formulas) {
            content = this.data.formulas[content];
        }
        /* if (this.dataview_regex) {
            const matches = content.match(this.dataview_regex) ?? [];

            for (const match of matches) {
                content = content.replace(match, `${this.inline.get(match)}`);
            }
        } */
        const lexemes = this.parse(content);

        const type = this.getTypeFromLexemes(lexemes);

        switch (type) {
            case "dice": {
                return new StackRoller(this, content, lexemes, showDice);
            }
            case "table": {
                return new TableRoller(
                    this,
                    content,
                    lexemes[0],
                    source,
                    showDice
                );
            }
            case "section": {
                return new SectionRoller(
                    this,
                    content,
                    lexemes[0],
                    source,
                    showDice
                );
            }
            case "tag": {
                if (!this.canUseDataview) {
                    throw new Error(
                        "Tags are only supported with the Dataview plugin installed."
                    );
                }
                return new TagRoller(
                    this,
                    content,
                    lexemes[0],
                    source,
                    showDice
                );
            }
            case "link": {
                return new LinkRoller(
                    this,
                    content,
                    lexemes[0],
                    source,
                    showDice
                );
            }
            case "line": {
                return new LineRoller(
                    this,
                    content,
                    lexemes[0],
                    source,
                    showDice
                );
            }
        }
    }
    getTypeFromLexemes(lexemes: Lexeme[]) {
        if (lexemes.some(({ type }) => type === "table")) {
            return "table";
        }
        if (lexemes.some(({ type }) => type === "section")) {
            return "section";
        }
        if (lexemes.some(({ type }) => type === "tag")) {
            return "tag";
        }
        if (lexemes.some(({ type }) => type === "link")) {
            return "link";
        }
        if (lexemes.some(({ type }) => type === "line")) {
            return "line";
        }
        return "dice";
    }

    addLexerRules() {
        this.lexer.addRule(/\s+/, function () {
            /* skip whitespace */
        });
        this.lexer.addRule(/[{}]+/, function () {
            /* skip brackets */
        });

        this.lexer.addRule(TABLE_REGEX, function (lexeme: string): Lexeme {
            return {
                type: "table",
                data: lexeme,
                original: lexeme,
                conditionals: null
            };
        });
        this.lexer.addRule(SECTION_REGEX, function (lexeme: string): Lexeme {
            const { groups } = lexeme.match(SECTION_REGEX);
            let type = "section";
            if (groups.types === "line") {
                type = "line";
            }
            return {
                type,
                data: lexeme,
                original: lexeme,
                conditionals: null
            };
        });

        this.lexer.addRule(TAG_REGEX, (lexeme: string): Lexeme => {
            const { groups } = lexeme.match(TAG_REGEX);
            let type = "tag";
            if (
                groups.types === "link" ||
                (this.data.rollLinksForTags && !groups.types?.length)
            ) {
                type = "link";
            }

            return {
                type,
                data: lexeme,
                original: lexeme,
                conditionals: null
            };
        });

        this.lexer.addRule(OMITTED_REGEX, (lexeme: string): Lexeme => {
            const {
                roll = this.data.defaultRoll,
                faces = this.data.defaultFace,
                conditional
            } = lexeme.match(OMITTED_REGEX).groups;

            let conditionals: Conditional[] = [];
            if (conditional) {
                let matches = conditional.matchAll(CONDITIONAL_REGEX);
                if (matches) {
                    for (let match of matches) {
                        if (!match) continue;
                        const { comparer, operator } = match.groups;
                        conditionals.push({
                            comparer: Number(comparer),
                            operator
                        });
                    }
                }
            }

            return {
                type: "dice",
                data: `${roll}d${faces}`,
                original: lexeme,
                conditionals
            }; // symbols
        });
        this.lexer.addRule(/\d+/, function (lexeme: string): Lexeme {
            return {
                type: "dice",
                data: lexeme,
                original: lexeme,
                conditionals: []
            };
        });

        this.lexer.addRule(MATH_REGEX, function (lexeme: string): Lexeme {
            return {
                type: "math",
                data: lexeme,
                original: lexeme,
                conditionals: null
            };
        });
        this.lexer.addRule(/1[Dd]S/, function (lexeme: string): Lexeme {
            const [, dice] = lexeme.match(/1[Dd]S/) ?? [, "1"];
            return {
                type: "stunt",
                data: dice,
                original: lexeme,
                conditionals: []
            }; // symbols
        });

        this.lexer.addRule(/kh?(?!:l)(\d*)/, function (lexeme: string): Lexeme {
            /** keep high */
            return {
                type: "kh",
                data: lexeme.replace(/^\D+/g, ""),
                original: lexeme,
                conditionals: null
            };
        });
        this.lexer.addRule(/dl?(?!:h)\d*/, function (lexeme: string): Lexeme {
            /** drop low */
            return {
                type: "dl",
                data: lexeme.replace(/^\D+/g, ""),
                original: lexeme,
                conditionals: null
            };
        });

        this.lexer.addRule(/kl\d*/, function (lexeme: string): Lexeme {
            /** keep low */
            return {
                type: "kl",
                data: lexeme.replace(/^\D+/g, ""),
                original: lexeme,
                conditionals: null
            };
        });
        this.lexer.addRule(/dh\d*/, function (lexeme: string): Lexeme {
            /** drop high */
            return {
                type: "dh",
                data: lexeme.replace(/^\D+/g, ""),
                original: lexeme,
                conditionals: null
            };
        });
        this.lexer.addRule(
            /!!(i|\d+)?(?:(!?=|=!|>=?|<=?)(-?\d+))*/,
            function (lexeme: string): Lexeme {
                /** explode and combine */
                let [, data = `1`] = lexeme.match(
                        /!!(i|\d+)?(?:(!?=|=!|>=?|<=?)(-?\d+))*/
                    ),
                    conditionals: Conditional[] = [];
                if (/(?:(!?=|=!|>=?|<=?)(-?\d+))+/.test(lexeme)) {
                    for (const [, operator, comparer] of lexeme.matchAll(
                        /(?:(!?=|=!|>=?|<=?)(-?\d+))/g
                    )) {
                        conditionals.push({
                            operator: operator,
                            comparer: Number(comparer)
                        });
                    }
                }
                if (/!!i/.test(lexeme)) {
                    data = `100`;
                }

                return {
                    type: "!!",
                    data: data,
                    original: lexeme,
                    conditionals: conditionals
                };
            }
        );
        this.lexer.addRule(
            /!(i|\d+)?(?:(!?=|=!?|>=?|<=?)(-?\d+))*/,
            function (lexeme: string): Lexeme {
                /** explode */
                let [, data = `1`] = lexeme.match(
                        /!(i|\d+)?(?:(!?=|=!?|>=?|<=?)(-?\d+))*/
                    ),
                    conditionals: Conditional[] = [];
                if (/(?:(!?=|=!|>=?|<=?)(\d+))+/.test(lexeme)) {
                    for (const [, operator, comparer] of lexeme.matchAll(
                        /(?:(!?=|=!?|>=?|<=?)(-?\d+))/g
                    )) {
                        conditionals.push({
                            operator: operator,
                            comparer: Number(comparer)
                        });
                    }
                }
                if (/!i/.test(lexeme)) {
                    data = `100`;
                }

                return {
                    type: "!",
                    data: data,
                    original: lexeme,
                    conditionals: conditionals
                };
            }
        );
        this.lexer.addRule(
            /r(i|\d+)?(?:(!?=|=!|>=?|<=?)(-?\d+))*/,
            function (lexeme: string): Lexeme {
                /** reroll */
                let [, data = `1`] = lexeme.match(
                        /r(i|\d+)?(?:(!?=|=!|>=?|<=?)(-?\d+))*/
                    ),
                    conditionals: Conditional[] = [];
                if (/(?:(!?={1,2}|>=?|<=?)(-?\d+))+/.test(lexeme)) {
                    for (const [, operator, comparer] of lexeme.matchAll(
                        /(?:(!?=|=!|>=?|<=?)(-?\d+))/g
                    )) {
                        conditionals.push({
                            operator: operator,
                            comparer: Number(comparer)
                        });
                    }
                }
                if (/ri/.test(lexeme)) {
                    data = `100`;
                }
                return {
                    type: "r",
                    data: data,
                    original: lexeme,
                    conditionals: conditionals
                };
            }
        );
        const self = this;
        this.lexer.addRule(
            /[A-Za-z][A-Za-z0-9_]+/,
            function (lexeme: string): Lexeme {
                if (self.inline.has(lexeme.trim())) {
                    return {
                        type: "dice",
                        data: `${self.inline.get(lexeme.trim())}`,
                        original: lexeme,
                        conditionals: []
                    };
                }
            }
        );
    }

    onunload() {
        console.log("DiceRoller unloaded");
        this.app.workspace
            .getLeavesOfType(VIEW_TYPE)
            .forEach((leaf) => leaf.detach());

        if ("__THREE__" in window) {
            delete window.__THREE__;
        }
        this.renderer.unload();
        this.app.workspace.trigger("dice-roller:unload");
    }

    operators: any = {
        "+": (a: number, b: number): number => a + b,
        "-": (a: number, b: number): number => a - b,
        "*": (a: number, b: number): number => a * b,
        "/": (a: number, b: number): number => a / b,
        "^": (a: number, b: number): number => {
            return Math.pow(a, b);
        }
    };

    parse(input: string): Lexeme[] {
        this.lexer.setInput(input);
        var tokens = [],
            token;
        while ((token = this.tryLex())) {
            tokens.push(token);
        }
        return this.parser.parse(tokens);
    }
    tryLex() {
        try {
            return this.lexer.lex();
        } catch (e) {}
    }
    private registerEvents() {
        this.registerEvent(
            this.app.workspace.on("dice-roller:update-colors", () => {
                this.renderer.factory.updateColors();
            })
        );

        this.registerEvent(
            this.app.workspace.on("dice-roller:render-dice", async (roll) => {
                const roller = await this.getRoller(roll, "external");

                if (!(roller instanceof StackRoller)) {
                    new Notice("The Dice View only supports dice rolls.");
                    return;
                }
                await roller.roll();
                if (!roller.dice.length) {
                    new Notice("Invalid formula.");
                    return;
                }
                try {
                    this.renderRoll(roller);
                } catch (e) {
                    new Notice("There was an error rendering the roll.");
                    console.error(e);
                }

                this.app.workspace.trigger(
                    "dice-roller:rendered-result",
                    roller.result
                );
            })
        );
    }
    private addCommands() {
        this.addCommand({
            id: "open-view",
            name: "Open Dice View",
            checkCallback: (checking) => {
                if (!this.view) {
                    if (!checking) {
                        this.addDiceView();
                    }
                    return true;
                }
            }
        });

        this.addCommand({
            id: "reroll",
            name: "Re-roll Dice",
            checkCallback: (checking) => {
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (
                    view &&
                    view.getMode() === "preview" &&
                    this.fileMap.has(view.file)
                ) {
                    if (!checking) {
                        const dice = this.fileMap.get(view.file);

                        dice.forEach((roller) => {
                            roller.roll();
                        });
                    }
                    return true;
                }
            }
        });
    }
    private addIcons() {
        const ICON_SVG = icon(faDice).html[0];

        addIcon(ICON_DEFINITION, ICON_SVG);

        const COPY_SVG = icon(faCopy).html[0];

        addIcon(COPY_DEFINITION, COPY_SVG);
    }

    private buildLexer() {
        this.lexer = new lexer();
        this.addLexerRules();
    }
    private buildParser() {
        const exponent = {
            precedence: 3,
            associativity: "right"
        };

        const factor = {
            precedence: 2,
            associativity: "left"
        };

        const term = {
            precedence: 1,
            associativity: "left"
        };

        this.parser = new Parser({
            "+": term,
            "-": term,
            "*": factor,
            "/": factor,
            "^": exponent
        });
    }
}
