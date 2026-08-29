export type QualificationStep = 'need' | 'budget' | 'timeline';

export interface QualificationOption {
  label: string;
  value: string;
}

export interface QualificationState {
  need?: string;
  budget?: string;
  timeline?: string;
}

export interface CompletedQualificationState {
  need: string;
  budget: string;
  timeline: string;
}

export interface LeadQualificationStore {
  get(userId: number): QualificationState | undefined;
  set(userId: number, state: QualificationState): void;
  delete(userId: number): void;
}

export const QUALIFICATION_QUESTIONS: Record<QualificationStep, string> = {
  need: 'What do you need help with?',
  budget: 'What budget range fits this project?',
  timeline: 'When do you want to launch?',
};

export const QUALIFICATION_OPTIONS: Record<QualificationStep, readonly QualificationOption[]> = {
  need: [
    { label: 'Website lead bot', value: 'website_lead_bot' },
    { label: 'Telegram automation', value: 'telegram_automation' },
    { label: 'Support bot', value: 'support_bot' },
  ],
  budget: [
    { label: 'Under $500', value: 'under_500' },
    { label: '$500–$2k', value: '500_2k' },
    { label: '$2k+', value: '2k_plus' },
  ],
  timeline: [
    { label: 'This week', value: 'this_week' },
    { label: 'This month', value: 'this_month' },
    { label: 'Just researching', value: 'just_researching' },
  ],
};

export class InMemoryLeadQualificationStore implements LeadQualificationStore {
  private readonly states = new Map<number, QualificationState>();

  public get(userId: number): QualificationState | undefined {
    return this.states.get(userId);
  }

  public set(userId: number, state: QualificationState): void {
    this.states.set(userId, state);
  }

  public delete(userId: number): void {
    this.states.delete(userId);
  }
}

export function nextQualificationStep(state: QualificationState): QualificationStep | undefined {
  if (state.need === undefined) return 'need';
  if (state.budget === undefined) return 'budget';
  if (state.timeline === undefined) return 'timeline';
  return undefined;
}

export function completedQualification(state: QualificationState): CompletedQualificationState | undefined {
  if (state.need === undefined || state.budget === undefined || state.timeline === undefined) return undefined;
  return { need: state.need, budget: state.budget, timeline: state.timeline };
}

export function saveQualificationAnswer(
  state: QualificationState,
  step: QualificationStep,
  value: string,
): QualificationState | undefined {
  if (nextQualificationStep(state) !== step) return undefined;
  if (!QUALIFICATION_OPTIONS[step].some((option) => option.value === value)) return undefined;
  return { ...state, [step]: value };
}

export function qualificationLabel(step: QualificationStep, value: string): string {
  return QUALIFICATION_OPTIONS[step].find((option) => option.value === value)?.label ?? value;
}

export function parseQualificationCallback(data: string): { step: QualificationStep; value: string } | undefined {
  const match = data.match(/^lead:(need|budget|timeline):([a-z0-9_]+)$/);
  if (!match) return undefined;
  return { step: match[1] as QualificationStep, value: match[2] };
}
