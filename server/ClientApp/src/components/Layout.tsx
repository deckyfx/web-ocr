import { type ParentProps } from "solid-js";
import { A } from "@solidjs/router";
import { BookOpen, Image, LayoutDashboard } from "lucide-solid";

interface NavItem {
  href: string;
  label: string;
  Icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", Icon: Image },
  { href: "/library", label: "Library", Icon: BookOpen },
];

export function Layout(props: ParentProps) {
  return (
    <div class="flex h-screen bg-slate-50 text-slate-800">
      {/* Sidebar */}
      <nav class="group flex w-14 flex-col gap-1 overflow-hidden bg-slate-900 px-2 py-4 transition-all duration-200 hover:w-48">
        {/* Logo mark */}
        <div class="mb-4 flex items-center gap-3 px-1">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-xs font-bold text-white">
            W
          </span>
          <span class="whitespace-nowrap text-sm font-semibold text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            WebOCR
          </span>
        </div>

        {/* Nav links */}
        {NAV_ITEMS.map((item) => (
          <A
            href={item.href}
            end={item.href === "/"}
            class="flex items-center gap-3 rounded-lg px-1 py-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            activeClass="bg-slate-800 text-white!"
          >
            <span class="flex h-8 w-8 shrink-0 items-center justify-center">
              <item.Icon class="h-5 w-5" />
            </span>
            <span class="whitespace-nowrap text-sm opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              {item.label}
            </span>
          </A>
        ))}
      </nav>

      {/* Main content */}
      <main class="flex-1 overflow-y-auto">{props.children}</main>
    </div>
  );
}
