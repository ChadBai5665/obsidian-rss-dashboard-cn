import { createTranslator, type Locale } from "../../i18n";
import {
  DEFAULT_INITIAL_IMPORT_POLICY,
  type InitialImportPolicy,
} from "../../sources/initial-import-policy";

export type SourceOnboardingKind = "rss-website" | "youtube" | "x-account";

export interface InitialImportControlOptions {
  locale?: Locale;
  sourceKind: SourceOnboardingKind;
  initialPolicy?: InitialImportPolicy;
  onChange?: (policy: InitialImportPolicy | undefined) => void;
}

export interface InitialImportControl {
  getPolicy(): InitialImportPolicy | undefined;
  focus(): void;
}

type Preset = "now" | "3" | "7" | "14" | "30" | "90" | "custom" | "all";

const PRESETS: ReadonlyArray<{ value: Preset; key: Parameters<ReturnType<typeof createTranslator>>[0] }> = [
  { value: "now", key: "sourceOnboarding.import.now" },
  { value: "3", key: "sourceOnboarding.import.days3" },
  { value: "7", key: "sourceOnboarding.import.days7" },
  { value: "14", key: "sourceOnboarding.import.days14" },
  { value: "30", key: "sourceOnboarding.import.days30" },
  { value: "90", key: "sourceOnboarding.import.days90" },
  { value: "custom", key: "sourceOnboarding.import.custom" },
  { value: "all", key: "sourceOnboarding.import.all" },
];

export function renderInitialImportControl(
  container: HTMLElement,
  options: InitialImportControlOptions,
): InitialImportControl {
  const t = createTranslator(options.locale ?? "zh-CN");
  const wrapper = container.createDiv({ cls: "rss-source-initial-import" });
  const label = wrapper.createEl("label", {
    cls: "rss-source-field-label",
    text: t("sourceOnboarding.import.label"),
  });
  const select = label.createEl("select", {
    cls: "rss-source-initial-import-select",
    attr: { "aria-label": t("sourceOnboarding.import.label") },
  });
  for (const preset of PRESETS) {
    select.createEl("option", { value: preset.value, text: t(preset.key) });
  }
  select.value = presetForPolicy(options.initialPolicy ?? DEFAULT_INITIAL_IMPORT_POLICY);

  const customContainer = wrapper.createDiv({ cls: "rss-source-custom-date" });
  const explanation = wrapper.createDiv({
    cls: "rss-source-availability-note",
    text: t(availabilityKey(options.sourceKind)),
  });
  void explanation;
  let dateInput: HTMLInputElement | undefined;
  let customDate = options.initialPolicy?.mode === "since-date"
    ? options.initialPolicy.since
    : "";

  const getPolicy = (): InitialImportPolicy | undefined => {
    if (select.value === "now") return { mode: "from-now" };
    if (select.value === "all") return { mode: "all-available" };
    if (select.value === "custom") {
      return dateInput?.value
        ? { mode: "since-date", since: dateInput.value }
        : undefined;
    }
    const days = Number(select.value);
    return Number.isSafeInteger(days) && days > 0
      ? { mode: "lookback-days", days }
      : undefined;
  };

  const notify = () => options.onChange?.(getPolicy());
  const renderDate = (): void => {
    customContainer.empty();
    dateInput = undefined;
    if (select.value !== "custom") return;
    dateInput = customContainer.createEl("input", {
      type: "date",
      cls: "rss-source-custom-date-input",
      attr: {
        "aria-label": t("sourceOnboarding.import.customDate"),
      },
    });
    dateInput.required = true;
    dateInput.value = customDate;
    dateInput.addEventListener("change", () => {
      customDate = dateInput?.value ?? "";
      notify();
    });
  };

  select.addEventListener("change", () => {
    renderDate();
    notify();
  });
  renderDate();

  return {
    getPolicy,
    focus: () => select.focus(),
  };
}

function presetForPolicy(policy: InitialImportPolicy): Preset {
  if (policy.mode === "from-now") return "now";
  if (policy.mode === "all-available") return "all";
  if (policy.mode === "since-date") return "custom";
  return ([3, 7, 14, 30, 90] as const).includes(
    policy.days as 3 | 7 | 14 | 30 | 90,
  )
    ? String(policy.days) as Preset
    : "7";
}

function availabilityKey(kind: SourceOnboardingKind):
  | "sourceOnboarding.import.rssAvailability"
  | "sourceOnboarding.import.youtubeAvailability"
  | "sourceOnboarding.import.xAvailability" {
  if (kind === "youtube") return "sourceOnboarding.import.youtubeAvailability";
  if (kind === "x-account") return "sourceOnboarding.import.xAvailability";
  return "sourceOnboarding.import.rssAvailability";
}
