import type { CloseManyPending } from "@/app/hooks/tabCloseGuards";
import {
  type AppCloseBlocker,
  canOptOutOfAppClosePrompt,
} from "@/app/hooks/useAppCloseGuard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { type MessageKey, useT } from "@/modules/i18n";
import { setConfirmCloseRunningTerminal } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { useId, useState } from "react";

type Props = {
  tabs: Tab[];
  pendingCloseTab: number | null;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  pendingTerminalCloseTab: number | null;
  onCancelTerminalClose: () => void;
  onConfirmTerminalClose: () => void;
  pendingDeleteTabs: number[] | null;
  onCancelDeleteClose: () => void;
  onConfirmDeleteClose: () => void;
  pendingCloseMany: CloseManyPending | null;
  closeManyConfirming: boolean;
  onCancelCloseMany: () => void;
  onConfirmCloseMany: () => void;
  pendingAppClose: AppCloseBlocker | null;
  onCancelAppClose: () => void;
  onConfirmAppClose: () => void;
};

/**
 * These dialogs say how many files or processes are involved, and there is no plural
 * rule in the message table: the count picks the key, the table holds the sentence.
 */
type Message = { key: MessageKey; values?: Record<string, string | number> };

function appCloseMessage(blocker: AppCloseBlocker): Message {
  if (blocker.dirtyEditors > 0 && blocker.busyTerminal) {
    return blocker.dirtyEditors === 1
      ? { key: "closeDialog.quit.dirtyOneAndBusy" }
      : {
          key: "closeDialog.quit.dirtyManyAndBusy",
          values: { count: blocker.dirtyEditors },
        };
  }
  if (blocker.dirtyEditors > 0) {
    return blocker.dirtyEditors === 1
      ? { key: "closeDialog.quit.dirtyOne" }
      : {
          key: "closeDialog.quit.dirtyMany",
          values: { count: blocker.dirtyEditors },
        };
  }
  return { key: "closeDialog.quit.busy" };
}

function OptOutRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  const id = useId();
  const t = useT();
  return (
    <div className="-mt-3 flex items-center justify-center gap-2 sm:justify-start">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className="font-normal text-[12px] text-muted-foreground"
      >
        {t("closeDialog.optOut")}
      </Label>
    </div>
  );
}

async function persistOptOut(): Promise<void> {
  try {
    await setConfirmCloseRunningTerminal(false);
  } catch (e) {
    console.error("close-confirmation opt-out failed", e);
  }
}

function closeManyMessage(
  pending: CloseManyPending,
  tabs: Tab[],
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): Message {
  const { kind, dirtyIds, busyLeafIds } = pending;
  const dirtyCount = dirtyIds.length;
  const busyCount = busyLeafIds.length;
  if (dirtyCount === 1 && busyCount === 0) {
    const title = tabs.find(
      (tab) => tab.kind === "editor" && dirtyIds.includes(tab.id),
    )?.title;
    return title
      ? { key: "closeDialog.many.oneDirtyNamed", values: { title } }
      : { key: "closeDialog.many.oneDirtyUnnamed" };
  }
  // Two counts, each with its own wording: translated here so the sentence that
  // combines them can be written naturally in either language.
  const dirty = t(
    dirtyCount === 1
      ? "closeDialog.frag.dirtyOne"
      : "closeDialog.frag.dirtyMany",
    { count: dirtyCount },
  );
  const busy = t(
    busyCount === 1 ? "closeDialog.frag.busyOne" : "closeDialog.frag.busyMany",
    { count: busyCount },
  );
  if (dirtyCount > 0 && busyCount > 0) {
    return { key: "closeDialog.many.dirtyAndBusy", values: { dirty, busy } };
  }
  if (dirtyCount > 0) {
    return { key: "closeDialog.many.dirtyOnly", values: { dirty } };
  }
  const key: MessageKey =
    busyCount === 1
      ? kind === "right"
        ? "closeDialog.many.busyRightOne"
        : "closeDialog.many.busyOtherOne"
      : kind === "right"
        ? "closeDialog.many.busyRightMany"
        : "closeDialog.many.busyOtherMany";
  return { key, values: { busy, count: busyCount } };
}

/** Confirmation dialogs for closing dirty editors and terminals with live processes. */
export function CloseDialogs({
  tabs,
  pendingCloseTab,
  onCancelClose,
  onConfirmClose,
  pendingTerminalCloseTab,
  onCancelTerminalClose,
  onConfirmTerminalClose,
  pendingDeleteTabs,
  onCancelDeleteClose,
  onConfirmDeleteClose,
  pendingCloseMany,
  closeManyConfirming,
  onCancelCloseMany,
  onConfirmCloseMany,
  pendingAppClose,
  onCancelAppClose,
  onConfirmAppClose,
}: Props) {
  const t = useT();
  const [optOutTerminalClose, setOptOutTerminalClose] = useState(false);
  const [optOutAppClose, setOptOutAppClose] = useState(false);
  const appCloseCanOptOut =
    pendingAppClose !== null && canOptOutOfAppClosePrompt(pendingAppClose);

  const confirmTerminalClose = () => {
    if (optOutTerminalClose) void persistOptOut();
    setOptOutTerminalClose(false);
    onConfirmTerminalClose();
  };

  const cancelTerminalClose = () => {
    setOptOutTerminalClose(false);
    onCancelTerminalClose();
  };

  // The pref write has to land before the window closes, or quitting drops it.
  const confirmAppClose = async () => {
    const optOut = appCloseCanOptOut && optOutAppClose;
    setOptOutAppClose(false);
    if (optOut) await persistOptOut();
    onConfirmAppClose();
  };

  const cancelAppClose = () => {
    setOptOutAppClose(false);
    onCancelAppClose();
  };

  const closeTabTitle = tabs.find((tab) => tab.id === pendingCloseTab)?.title;
  const closeManyText = pendingCloseMany
    ? closeManyMessage(pendingCloseMany, tabs, t)
    : null;
  const appCloseText = pendingAppClose
    ? appCloseMessage(pendingAppClose)
    : null;

  return (
    <>
      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => !open && onCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tabs.unsaved")}</AlertDialogTitle>
            <AlertDialogDescription>
              {closeTabTitle
                ? t("closeDialog.unsaved.named", { title: closeTabTitle })
                : t("closeDialog.unsaved.unnamed")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelClose}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmClose}>
              {t("closeDialog.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingTerminalCloseTab !== null}
        onOpenChange={(open) => !open && cancelTerminalClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("closeDialog.terminal.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("closeDialog.terminal.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <OptOutRow
            checked={optOutTerminalClose}
            onCheckedChange={setOptOutTerminalClose}
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelTerminalClose}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmTerminalClose}>
              {t("closeDialog.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteTabs !== null}
        onOpenChange={(open) => !open && onCancelDeleteClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tabs.unsaved")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTabs?.length === 1
                ? (() => {
                    const title = tabs.find(
                      (t) => t.id === pendingDeleteTabs[0],
                    )?.title;
                    return title
                      ? t("closeDialog.deleted.named", { title })
                      : t("closeDialog.deleted.unnamed");
                  })()
                : t("closeDialog.deleted.many", {
                    count: pendingDeleteTabs?.length ?? 0,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelDeleteClose}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteClose}>
              {t("closeDialog.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingCloseMany !== null}
        onOpenChange={(open) => !open && onCancelCloseMany()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                pendingCloseMany?.kind === "right"
                  ? "tabs.closeRight"
                  : "tabs.closeOthers",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {closeManyText ? t(closeManyText.key, closeManyText.values) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelCloseMany}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={closeManyConfirming}
              onClick={(event) => {
                event.preventDefault();
                onConfirmCloseMany();
              }}
            >
              {closeManyConfirming
                ? t("closeDialog.many.confirming")
                : t("closeDialog.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingAppClose !== null}
        onOpenChange={(open) => !open && cancelAppClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeDialog.quit.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {appCloseText ? t(appCloseText.key, appCloseText.values) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {appCloseCanOptOut ? (
            <OptOutRow
              checked={optOutAppClose}
              onCheckedChange={setOptOutAppClose}
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelAppClose}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmAppClose()}>
              {t("closeDialog.quit.anyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
