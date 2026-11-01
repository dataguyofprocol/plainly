"use client";

import type { AuthKeyStatus } from "@/src/core";
import { classifyKeys, type ProviderKeyInfo } from "@/components/settings/keys-section";
import { useModelCatalog } from "@/components/model-picker";
import type { ModelCatalogResponse } from "@/src/core";
import { Icon } from "@/components/ui/icon";

export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): boolean {
	return classifyKeys(statuses, providers).providerRows.some((s) => s.present);
}

export function useZeroKeys(): boolean {
	const { catalog } = useModelCatalog();
	return catalog ? !catalog.providers.some((provider) => provider.keyPresent) : false;
}

export function ZeroKeysPill({ onOpen, inline = false }: { onOpen: () => void; inline?: boolean }) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-keys"
			onClick={onOpen}
			className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-brand-soft px-3 text-xs font-semibold whitespace-nowrap text-brand shadow-[inset_0_0_0_1px_var(--brand-line)] transition-colors hover:bg-brand hover:text-primary-foreground active:scale-[0.97]"
		>
			<Icon name="key" size="sm" />
			Add a provider key
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}
export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((p) => p.id === strong.model.provider && p.keyPresent);
}

export function useStrongKeyless(): boolean {
	const { catalog } = useModelCatalog();
	return strongKeyless(catalog);
}
