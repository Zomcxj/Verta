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
import { useT } from "@/modules/i18n";

/**
 * "These names are already here - replace them?"
 *
 * Asked once per drop, and the answer is applied to every name in it. There is no "remember this"
 * and no per-file variant on purpose: a drop is one gesture, and the choice belongs to that
 * gesture. A remembered answer would either replace files the user never looked at, or refuse to
 * replace ones they asked for, depending on what they answered last week.
 */
export function DropConflictDialog({
  names,
  onChoose,
}: {
  names: readonly string[];
  onChoose: (choice: "replace" | "skip" | null) => void;
}) {
  const t = useT();
  const open = names.length > 0;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Dismissing is "skip": nothing is replaced, which is the answer that cannot lose data.
        if (!next) onChoose(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("explorer.dropConflictTitle", { count: names.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {names.length === 1
              ? t("explorer.dropConflictOne", { name: names[0] })
              : t("explorer.dropConflictMany", { count: names.length })}
            {names.length > 1 ? (
              // Plain text, not a boxed list: a bordered panel with names in it reads as a field
              // waiting to be typed into, and there is nothing here to type.
              <span className="mt-1 block text-foreground/80">
                {names.slice(0, 5).join("、")}
                {names.length > 5
                  ? ` ${t("explorer.dropConflictMore", { count: names.length - 5 })}`
                  : ""}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onChoose("skip")}>
            {t("explorer.dropConflictSkip")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => onChoose("replace")}>
            {t("explorer.dropConflictReplace")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
