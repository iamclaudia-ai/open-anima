/**
 * Today Extension — Route declarations.
 */

import type { ExtensionWebContribution, Route } from "@anima/ui";
import { Sunrise } from "lucide-react";
import { TodayPage } from "./pages/TodayPage";
import { TodaySectionPage } from "./pages/TodaySectionPage";

export const todayRoutes: Route[] = [
  { path: "/today", component: TodayPage, label: "Today", title: "Today" },
  { path: "/today/:section", component: TodaySectionPage, label: "Today", title: "Today" },
];

export default {
  id: "today",
  name: "Today",
  order: 5,
  icon: Sunrise,
  color: {
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
    ring: "ring-amber-200/70",
    hoverText: "group-hover:text-amber-700",
  },
  routes: todayRoutes,
} satisfies ExtensionWebContribution;
