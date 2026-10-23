export type AskFieldType = "single_select" | "multi_select" | "text";
export type AskOption = {
    description?: string;
    label: string;
    value: string;
};
export type AskMissingField = {
    allowCustom?: boolean;
    allowedOptions?: AskOption[];
    candidateHints?: string[];
    field: string;
    questionHint?: string;
    reason: string;
    required: boolean;
    typeHint?: AskFieldType;
};
export type TrustedAskUserProfile = {
    callPreference?: string;
    gender?: "male" | "female" | "nonbinary" | "unknown" | "secret";
    nickname?: string;
};
export type AskClarificationInput = {
    missingFields: AskMissingField[];
    recentAddressedUser?: boolean;
    trustedUserProfile?: TrustedAskUserProfile;
    userRequest: string;
};
export type AskQuestion = {
    allowCustom: boolean;
    field: string;
    freeTextPlaceholder: string;
    options: AskOption[];
    question: string;
    type: AskFieldType;
};
export type AskClarificationOutput = {
    deferredFields: string[];
    intro: string;
    questions: AskQuestion[];
};
export type AskClarificationCard = {
    deferredFields: string[];
    intro: string;
    mode?: AskCardMode;
    questions: AskQuestion[];
};
export type AskUserAnswer = {
    answers: Array<{
        customText?: string;
        field: string;
        selectedValues?: string[];
    }>;
    requestId: string;
};
export type AskCardMode = "action_parameters" | "semantic_clarification";
export type AskCardPayload = {
    interactionId: string;
    intro: string;
    mode: AskCardMode;
    questions: AskQuestionView[];
    revision: number;
    runId: string;
};
export type AskQuestionView = {
    customInput: {
        enabled: boolean;
        placeholder?: string;
    };
    id: string;
    multiple: boolean;
    options: AskOptionView[];
    prompt: string;
    required: true;
};
export type AskOptionView = {
    description?: string;
    id: string;
    label: string;
};
export type AskAnswerSubmission = {
    optionId?: string;
    optionIds?: string[];
    questionId: string;
    source: "option";
} | {
    questionId: string;
    source: "custom";
    text: string;
};
export type AskCardSubmission = {
    answers: AskAnswerSubmission[];
    interactionId: string;
    revision: number;
    runId: string;
};
