import math
from typing import Dict, Any, List, Tuple, Optional

class GlobalLaunchTrajectoryEngine:
    """
    面向 The Space Devs (Launch Library 2 API) 的全球通用火箭发射轨迹与落区预测引擎
    支持全球任意发射场、任意轨道倾角 (LEO/SSO/GTO/ISS/极轨/逆行轨道) 的主动段与入轨段连续解算
    """
    R_E = 6371.0                # 地球平均半径 (km)
    OMEGA_E = 7.292115e-5       # 地球自转角速度 (rad/s)
    V_ORBIT_DEFAULT = 7.78      # 默认入轨惯性水平速度 (km/s)

    # 全球特殊发射场射向约束库 (根据海岸线与邻国领空限制预设南北射向)
    # 键为发射场名称关键词，值为在发射高倾角(SSO/极轨)或同纬度轨道时是否强制向南(Descending)发射
    SOUTHWARD_PADS_KEYWORDS = [
        "Vandenberg",   # 美国范登堡：向南/西南入太平洋
        "Taiyuan",      # 中国太原：向南偏西飞
        "Jiuquan",      # 中国酒泉：SSO向南偏西，空间站(41.5°)向东南
        "Xichang",      # 中国西昌：GTO向东南飞
        "Mahia",        # 新西兰Rocket Lab：高倾角向南入南太平洋
        "Sriharikota",  # 印度萨迪什达万：SSO向南偏东绕过斯里兰卡
        "Andøya",       # 挪威安岛
        "Kodiak"        # 美国阿拉斯加科迪亚克：向南入太平洋
    ]

    @classmethod
    def parse_ll2_launch(cls, ll2_json: Dict[str, Any]) -> Dict[str, Any]:
        """
        步骤 1：解析 Launch Library 2 API 的单次发射 JSON 对象，提取并补全缺失的轨道与火箭参数
        """
        pad = ll2_json.get("pad") or {}
        location = pad.get("location") or {}
        mission = ll2_json.get("mission") or {}
        orbit = mission.get("orbit") or {}
        rocket_cfg = (ll2_json.get("rocket") or {}).get("configuration") or {}

        lat0 = float(pad.get("latitude") or 28.562)
        lon0 = float(pad.get("longitude") or -80.577)
        pad_name = f"{pad.get('name', '')} {location.get('name', '')}"
        rocket_name = rocket_cfg.get("full_name") or rocket_cfg.get("name") or "Generic Rocket"
        orbit_abbrev = (orbit.get("abbrev") or "LEO").upper()

        # 1. 获取或推算轨道倾角 (Inclination)
        inc_raw = orbit.get("inclination")
        if inc_raw is not None:
            inc_deg = float(inc_raw)
        else:
            inc_deg = cls._infer_inclination(lat0, lon0, pad_name, orbit_abbrev, mission.get("name", ""))

        # 2. 判断向北(Ascending)还是向南(Descending)发射
        launch_southward = cls._determine_southward(lat0, inc_deg, pad_name, orbit_abbrev)

        # 3. 匹配火箭构型包线 (可回收火箭 vs 传统带助推器火箭 vs 小型运载火箭)
        profile_type = cls._classify_rocket_profile(rocket_name)

        return {
            "launch_id": ll2_json.get("id", "unknown"),
            "launch_name": ll2_json.get("name", "Unknown Launch"),
            "pad_name": pad_name.strip(),
            "rocket_name": rocket_name,
            "orbit_abbrev": orbit_abbrev,
            "lat0_deg": lat0,
            "lon0_deg": lon0,
            "inclination_deg": inc_deg,
            "launch_southward": launch_southward,
            "profile_type": profile_type
        }

    @classmethod
    def _infer_inclination(cls, lat0: float, lon0: float, pad_name: str, orbit_abbrev: str, mission_name: str) -> float:
        """当 LL2 API 未提供 inclination 时，根据物理规律与任务类型自动推算"""
        abs_lat = abs(lat0)
        m_upper = mission_name.upper()

        # 以色列帕勒马希姆发射场：只能向西穿越地中海逆行发射
        if "PALMACHIM" in pad_name.upper() or (31.5 < lat0 < 32.5 and 34.0 < lon0 < 35.0):
            return 142.0

        if orbit_abbrev == "ISS" or "ISS" in m_upper or "DRAGON" in m_upper or "CYGNUS" in m_upper or "PROGRESS" in m_upper or "SOYUZ MS" in m_upper:
            return max(51.64, abs_lat)
        if "SHENZHOU" in m_upper or "TIANZHOU" in m_upper or "TIANGONG" in m_upper or "CSS" in orbit_abbrev:
            return 41.47
        if orbit_abbrev in ("SSO", "SUN-SYNCHRONOUS"):
            return 97.6
        if orbit_abbrev in ("PO", "POLAR"):
            return 90.0
        if orbit_abbrev in ("GTO", "GEO", "GSO"):
            # 文昌GTO约19.5°，库鲁约5.2°，卡角约27~28.5°，西昌约28.5°
            return max(abs_lat, 5.2)
        if "STARLINK" in m_upper:
            return 53.0 if abs_lat < 53.0 else 70.0

        # 默认 LEO：比发射场纬度高 1.5° 以避免极值奇异点
        return min(90.0, max(abs_lat + 1.5, 28.5))

    @classmethod
    def _determine_southward(cls, lat0: float, inc_deg: float, pad_name: str, orbit_abbrev: str) -> bool:
        """判定火箭起飞后是向偏北(False)还是偏南(True)飞行"""
        # 1. 如果发射场在特定的向南发射列表中
        for kw in cls.SOUTHWARD_PADS_KEYWORDS:
            if kw.upper() in pad_name.upper():
                # 特例：酒泉发射空间站(41.47°)也是偏东南，SSO(97.6°)是偏西南，均为向南分量主导
                return True

        # 2. 如果发射太阳同步轨道(SSO)，除俄罗斯普列谢茨克/东方发射场向北外，其余多向南避开陆地
        if orbit_abbrev == "SSO" and lat0 < 50.0:
            return True

        # 3. 当目标倾角几乎等于发射场纬度（差值 < 1.0°），向东发射后立即过顶点向赤道侧（北半球向南）下压
        if lat0 > 0 and abs(inc_deg - abs(lat0)) < 1.0:
            return True

        return False

    @classmethod
    def _classify_rocket_profile(cls, rocket_name: str) -> str:
        """根据火箭名称划分动力学时序模板"""
        r_up = rocket_name.upper()
        if any(k in r_up for k in ["FALCON 9", "FALCON HEAVY", "NEW GLENN", "ZHUQUE-3", "LONG MARCH 10"]):
            return "REUSABLE_2STAGE"      # 一级分离极早(约150s, 高度70km)，带动力减速回收
        if any(k in r_up for k in ["LONG MARCH", "SOYUZ", "ARIANE", "VULCAN", "ATLAS", "H-IIA", "H3", "GSLV", "PSLV", "PROTON", "ANGARA"]):
            return "EXPENDABLE_BOOSTER"   # 传统带助推器/多级构型 (助推120~155s分离，一级160~240s分离)
        return "LIGHT_2STAGE"             # 小型两级火箭 (Electron, Alpha, Ceres-1 等)

    @classmethod
    def compute_ground_azimuth(cls, lat0_deg: float, inc_deg: float, launch_southward: bool) -> Tuple[float, float]:
        """
        步骤 2：全球通用方位角解算器
        返回: (A_inertial_deg 惯性方位角, A_ground_deg 地表有效初始射向角)
        """
        lat0 = math.radians(lat0_deg)
        inc = math.radians(inc_deg)

        # 1. 球面几何求惯性方位角 A_inertial
        cos_lat0 = max(1e-6, math.cos(lat0))
        sin_A_iner = max(-1.0, min(1.0, math.cos(inc) / cos_lat0))

        # asin 返回 [-pi/2, pi/2]（即偏北象限：东北 0~90° 或 西北 -90~0°）
        A_iner_north = math.asin(sin_A_iner)
        if not launch_southward:
            A_iner = A_iner_north % (2 * math.pi)
        else:
            # 向南发射：对称映射到东南(90~180°)或西南(180~270°)
            A_iner = (math.pi - A_iner_north) % (2 * math.pi)

        # 2. 扣除发射场地球自转牵连线速度 V_rot，求地表相对速度矢量角
        v_rot = cls.OMEGA_E * cls.R_E * math.cos(lat0)  # km/s (向东为正)
        vn_rel = cls.V_ORBIT_DEFAULT * math.cos(A_iner)
        ve_rel = cls.V_ORBIT_DEFAULT * math.sin(A_iner) - v_rot
        A_ground = math.atan2(ve_rel, vn_rel) % (2 * math.pi)

        # 3. 地球曲率与主动段科里奥利累积偏转角自适应补偿
        # 当火箭向东飞行（0 < sin(A_iner) <= 1）且接近轨道极值纬度时，主动段580s内轨迹向赤道侧自然弯曲
        # 约相当于球面大圆走过 ~10° 地心角带来的航向旋转：dA ≈ 0.5 * d_lon * sin(lat0)
        mean_sigma_active = 1100.0 / cls.R_E  # 主动段平均半射程对应的地心角 (~0.17 rad)
        coriolis_curve = math.degrees(mean_sigma_active * math.sin(lat0) * math.sin(A_iner))
        A_ground_eff_deg = (math.degrees(A_ground) + coriolis_curve) % 360.0

        return round(math.degrees(A_iner), 2), round(A_ground_eff_deg, 2)

    @classmethod
    def generate_prediction(cls, ll2_json: Dict[str, Any], max_time_s: int = 900, step_s: int = 10) -> Dict[str, Any]:
        """
        步骤 3：一键生成完整轨迹点序列、关键分离事件与残骸落区坐标
        """
        meta = cls.parse_ll2_launch(ll2_json)
        lat0_deg, lon0_deg = meta["lat0_deg"], meta["lon0_deg"]
        inc_deg = meta["inclination_deg"]
        southward = meta["launch_southward"]

        A_iner_deg, A_ground_deg = cls.compute_ground_azimuth(lat0_deg, inc_deg, southward)
        meta["azimuth_inertial_deg"] = A_iner_deg
        meta["azimuth_ground_eff_deg"] = A_ground_deg

        # 根据火箭类别加载标准运动学关键帧: (t_s, range_km, alt_km, vh_kms, vv_kms, event_label)
        keyframes, drop_configs = cls._get_kinematic_template(meta["profile_type"])
        t_meco = 580.0

        lat0_rad = math.radians(lat0_deg)
        lon0_rad = math.radians(lon0_deg)
        A_g_rad = math.radians(A_ground_deg)

        def range_to_ecefloc(s_km: float) -> Tuple[float, float]:
            """沿地表有效大圆计算给定射程处的经纬度（保证主动段与落区 100% 重合）"""
            sigma = s_km / cls.R_E
            sin_lat = (math.sin(lat0_rad) * math.cos(sigma) +
                       math.cos(lat0_rad) * math.sin(sigma) * math.cos(A_g_rad))
            lat_r = math.asin(max(-1.0, min(1.0, sin_lat)))
            y = math.sin(sigma) * math.sin(A_g_rad)
            x = (math.cos(lat0_rad) * math.cos(sigma) -
                 math.sin(lat0_rad) * math.sin(sigma) * math.cos(A_g_rad))
            lon_r = lon0_rad + math.atan2(y, x)
            # 经度归一化到 [-180, 180]
            lon_d = (math.degrees(lon_r) + 180.0) % 360.0 - 180.0
            return round(math.degrees(lat_r), 4), round(lon_d, 4)

        def interp_kf(t_val: float) -> Dict[str, Any]:
            for i in range(len(keyframes) - 1):
                t0, s0, h0, vh0, vv0, _ = keyframes[i]
                t1, s1, h1, vh1, vv1, _ = keyframes[i + 1]
                if t0 <= t_val <= t1:
                    r = (t_val - t0) / max(1e-6, (t1 - t0))
                    s = s0 + r * (s1 - s0)
                    h = h0 + r * (h1 - h0)
                    vh = vh0 + r * (vh1 - vh0)
                    vv = vv0 + r * (vv1 - vv0)
                    lat, lon = range_to_ecefloc(s)
                    return {"t": round(t_val, 1), "range_km": round(s, 1), "alt_km": round(h, 1),
                            "vh_kms": round(vh, 2), "vv_kms": round(vv, 2), "lat": lat, "lon": lon,
                            "phase": "ACTIVE" if t_val <= t_meco else "ORBIT"}
            kf = keyframes[-1]
            lat, lon = range_to_ecefloc(kf[1])
            return {"t": t_val, "range_km": kf[1], "alt_km": kf[2], "vh_kms": kf[3], "vv_kms": kf[4],
                    "lat": lat, "lon": lon, "phase": "ORBIT"}

        # 1. 生成连续轨迹时间序列
        trajectory = [interp_kf(float(t)) for t in range(0, max_time_s + 1, step_s)]

        # 2. 提取关键飞行事件坐标
        events = []
        for kf in keyframes:
            if kf[5]:
                st = interp_kf(kf[0])
                events.append({"event": kf[5], **st})

        # 3. 计算各级残骸落区（严格压在航迹正下方）
        drop_zones = []
        for stage_name, t_sep, drag_eta in drop_configs:
            sep_st = interp_kf(t_sep)
            if drag_eta < 0:
                # 针对 Falcon 9 RTLS 陆地返场回收情况
                drop_range = 0.0
            else:
                g_eff = 9.5
                h_m = sep_st["alt_km"] * 1000.0
                vv_ms = sep_st["vv_kms"] * 1000.0
                t_fall = (vv_ms + math.sqrt(vv_ms**2 + 2 * g_eff * h_m)) / g_eff
                drop_range = sep_st["range_km"] + drag_eta * sep_st["vh_kms"] * t_fall

            d_lat, d_lon = range_to_ecefloc(drop_range)
            drop_zones.append({
                "stage": stage_name,
                "sep_time_s": t_sep,
                "sep_lat": sep_st["lat"],
                "sep_lon": sep_st["lon"],
                "drop_range_km": round(drop_range, 1),
                "drop_lat": d_lat,
                "drop_lon": d_lon
            })

        return {
            "metadata": meta,
            "events": events,
            "drop_zones": drop_zones,
            "trajectory": trajectory
        }

    @classmethod
    def _get_kinematic_template(cls, profile_type: str) -> Tuple[List[tuple], List[tuple]]:
        """返回对应火箭构型的关键帧与落区阻力折合系数"""
        if profile_type == "REUSABLE_2STAGE":
            # 如 Falcon 9 / 长征十号甲：一级分离早，海上回收船位于 ~630km 处
            kf = [
                (0.0,   0.0,    0.1,   0.00, 0.00, "Liftoff (点火起飞)"),
                (70.0,  15.0,   14.0,  0.42, 0.35, "Max-Q (最大动压)"),
                (152.0, 95.0,   68.0,  1.95, 0.65, "MECO & Stage 1 Sep (一级分离)"),
                (195.0, 210.0,  108.0, 2.50, 0.45, "Fairing Deploy (整流罩分离)"),
                (360.0, 880.0,  180.0, 4.60, 0.20, None),
                (510.0, 1950.0, 210.0, 7.50, 0.02, "SECO-1 / Orbit Insertion (二级关机入轨)"),
                (580.0, 2475.0, 212.0, 7.50, 0.00, None),
                (900.0, 4875.0, 220.0, 7.50, 0.00, None)
            ]
            # (名称, 分离时间s, 气动/返推折合系数 eta) -> 一级海上回收点火减速 eta≈0.38 (落点约630km)
            drops = [
                ("Stage 1 Booster (ASDS 海上回收区)", 152.0, 0.38),
                ("Fairing Halves (整流罩回收区)", 195.0, 0.72)
            ]
            return kf, drops

        # 默认：传统多级/带助推器构型 (Long March 2F/3B/5/7, Soyuz, Ariane, Atlas V 等)
        kf = [
            (0.0,   0.0,    0.5,   0.00, 0.00, "Liftoff (点火起飞)"),
            (120.0, 45.0,   42.0,  0.85, 0.55, "Tower/Early Sep (逃逸塔或早期分离)"),
            (155.0, 115.0,  62.0,  1.65, 0.58, "Booster Sep (助推器分离)"),
            (165.0, 135.0,  70.0,  1.85, 0.60, "Core Stage 1 Sep (一子级分离)"),
            (205.0, 250.0,  110.0, 2.48, 0.45, "Fairing Sep (整流罩抛离)"),
            (350.0, 780.0,  172.0, 4.20, 0.25, None),
            (460.0, 1420.0, 195.0, 6.30, 0.08, "Stage 2 Main Cutoff (二级主机关机)"),
            (580.0, 2250.0, 200.0, 7.45, 0.00, "Orbit Insertion (船箭/星箭分离入轨)"),
            (900.0, 4630.0, 210.0, 7.45, 0.00, None)
        ]
        drops = [
            ("Side Boosters (助推器落区)", 155.0, 0.58),
            ("Core Stage 1 (一子级落区)", 165.0, 0.85),
            ("Payload Fairing (整流罩落区)", 205.0, 0.72)
        ]
        return kf, drops