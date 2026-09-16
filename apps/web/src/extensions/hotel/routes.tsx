import Archive from "./pages/Archive";
import Channels from "./pages/Channels";
import FrontdeskHousekeeping from "./pages/FrontdeskHousekeeping";
import Goals from "./pages/Goals";
import Incidents from "./pages/Incidents";
import Orders from "./pages/Orders";
import PriceHealth from "./pages/PriceHealth";
import Reputation from "./pages/Reputation";
import Revenue from "./pages/Revenue";
import Stores from "./pages/Stores";
import VoiceFront from "./pages/VoiceFront";

/**
 * 酒店 PC 行业能力只在扩展目录注册。legacyPaths 仅用于旧书签迁移，
 * 不会占用任务、审批、技能、数字员工等基座能力路由。
 */
export const industryRoutes = [
  { path: "/hotel/incidents", capabilityId: "hotel.incidents", element: <Incidents />, legacyPaths: ["/p10"] },
  { path: "/hotel/price-health", capabilityId: "hotel.price-health", element: <PriceHealth />, legacyPaths: ["/p11"] },
  { path: "/hotel/goals", capabilityId: "hotel.goals", element: <Goals />, legacyPaths: ["/p12"] },
  { path: "/hotel/orders", capabilityId: "hotel.orders", element: <Orders />, legacyPaths: ["/p13"] },
  { path: "/hotel/channels", capabilityId: "hotel.channels", element: <Channels />, legacyPaths: ["/p14"] },
  { path: "/hotel/reputation", capabilityId: "hotel.reputation", element: <Reputation />, legacyPaths: ["/p15"] },
  { path: "/hotel/voice-front", capabilityId: "hotel.voice-front", element: <VoiceFront />, legacyPaths: ["/p16"] },
  { path: "/hotel/frontdesk-housekeeping", capabilityId: "hotel.frontdesk-housekeeping", element: <FrontdeskHousekeeping />, legacyPaths: ["/p17"] },
  { path: "/hotel/stores", capabilityId: "hotel.stores", element: <Stores />, legacyPaths: ["/p18"] },
  { path: "/hotel/revenue", capabilityId: "hotel.revenue", element: <Revenue />, legacyPaths: ["/p19"] },
  { path: "/hotel/archive", capabilityId: "hotel.archive", element: <Archive />, legacyPaths: ["/p20"] },
] as const;
