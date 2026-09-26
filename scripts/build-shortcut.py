#!/usr/bin/env python3
"""生成“存到链接坞”iOS 快捷指令，并用 macOS 的 `shortcuts sign` 签名。

生成的文件不包含上传密钥：导入时 iOS 会依次询问站点地址（预填默认值）和上传密钥。

用法：
    python3 scripts/build-shortcut.py [站点地址]
输出：
    public/shortcut/LinkDock.shortcut（已签名，可通过网页下载或 AirDrop 安装）
"""

import os
import plistlib
import subprocess
import sys
import tempfile
import uuid

DEFAULT_SITE = "https://linkdock.mingyuanw.workers.dev"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "shortcut", "LinkDock.shortcut")

OBJ = "￼"  # 文本中插入变量的位置占位符


def new_uuid() -> str:
    return str(uuid.uuid4()).upper()


def output_ref(action_uuid: str, name: str) -> dict:
    return {"OutputUUID": action_uuid, "OutputName": name, "Type": "ActionOutput"}


def attachment(ref: dict) -> dict:
    """单个变量作为参数。"""
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def text(template: str, refs: list) -> dict:
    """带变量的文本：template 中的每个 OBJ 依次对应 refs 中的变量。"""
    ranges = {}
    positions = [i for i, ch in enumerate(template) if ch == OBJ]
    assert len(positions) == len(refs)
    for pos, ref in zip(positions, refs):
        # Shortcuts 按 UTF-16 偏移计算范围
        offset = len(template[:pos].encode("utf-16-le")) // 2
        ranges[f"{{{offset}, 1}}"] = ref
    value = {"string": template}
    if ranges:
        value["attachmentsByRange"] = ranges
    return {"Value": value, "WFSerializationType": "WFTextTokenString"}


def dictionary(items: list) -> dict:
    return {
        "Value": {
            "WFDictionaryFieldValueItems": [
                {"WFItemType": 0, "WFKey": text(k, []), "WFValue": v} for k, v in items
            ]
        },
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(identifier: str, **params) -> dict:
    return {"WFWorkflowActionIdentifier": identifier, "WFWorkflowActionParameters": params}


def build(site: str) -> dict:
    site_id, key_id, urls_id, item_id, if_group, request_id, value_id = (
        new_uuid() for _ in range(7)
    )
    site_ref = output_ref(site_id, "文本")
    key_ref = output_ref(key_id, "文本")
    item_ref = output_ref(item_id, "列表中的项目")
    request_ref = output_ref(request_id, "URL 的内容")
    value_ref = output_ref(value_id, "词典值")

    actions = [
        # 0：站点地址（导入时询问）
        action("is.workflow.actions.comment",
               WFCommentActionText="存到链接坞：把分享的网页链接保存到 LinkDock。站点地址与上传密钥在导入时填写，可在下方两个文本动作中修改。"),
        action("is.workflow.actions.gettext", UUID=site_id, WFTextActionText=site),
        # 2：上传密钥（导入时询问）
        action("is.workflow.actions.gettext", UUID=key_id, WFTextActionText=""),
        # 从分享输入中提取链接，只取第一个。
        # 此动作的输入是文本参数，变量必须以文本（WFTextTokenString）形式嵌入；
        # 若写成 WFTextTokenAttachment，iOS 读到的输入为空，结果总是“没有找到链接”。
        action("is.workflow.actions.detect.link", UUID=urls_id,
               WFInput=text(OBJ, [{"Type": "ExtensionInput"}])),
        action("is.workflow.actions.getitemfromlist", UUID=item_id,
               WFInput=attachment(output_ref(urls_id, "URL")), WFItemSpecifier="First Item"),
        # 没有链接时提示并停止
        action("is.workflow.actions.conditional", GroupingIdentifier=if_group, WFControlFlowMode=0,
               WFCondition=101,
               WFInput={"Type": "Variable", "Variable": attachment(item_ref)}),
        action("is.workflow.actions.alert", WFAlertActionTitle="链接坞",
               WFAlertActionMessage="没有找到可保存的网页链接。请在网页的分享菜单中使用此快捷指令。",
               WFAlertActionCancelButtonShown=False),
        action("is.workflow.actions.exit"),
        action("is.workflow.actions.conditional", GroupingIdentifier=if_group, WFControlFlowMode=1),
        action("is.workflow.actions.conditional", GroupingIdentifier=if_group, WFControlFlowMode=2),
        # 提交
        action("is.workflow.actions.downloadurl", UUID=request_id,
               WFURL=text(f"{OBJ}/api/links", [site_ref]),
               WFHTTPMethod="POST",
               ShowHeaders=True,
               WFHTTPHeaders=dictionary([("Authorization", text(f"Bearer {OBJ}", [key_ref]))]),
               WFHTTPBodyType="JSON",
               WFJSONValues=dictionary([("url", text(OBJ, [item_ref]))])),
        # 服务端对成功和失败都返回可展示的 message
        action("is.workflow.actions.getvalueforkey", UUID=value_id,
               WFInput=attachment(request_ref), WFDictionaryKey="message",
               WFGetDictionaryValueType="Value"),
        action("is.workflow.actions.notification", WFNotificationActionTitle="链接坞",
               WFNotificationActionBody=text(OBJ, [value_ref])),
    ]

    return {
        "WFWorkflowClientVersion": "2607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 463140863, "WFWorkflowIconGlyphNumber": 61440},
        "WFWorkflowTypes": ["ActionExtension"],
        "WFQuickActionSurfaces": [],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowInputContentItemClasses": [
            "WFURLContentItem",
            "WFSafariWebPageContentItem",
            "WFStringContentItem",
        ],
        "WFWorkflowImportQuestions": [
            {
                "ActionIndex": 1,
                "Category": "Parameter",
                "ParameterKey": "WFTextActionText",
                "DefaultValue": site,
                "Text": "LinkDock 站点地址（通常保持默认）",
            },
            {
                "ActionIndex": 2,
                "Category": "Parameter",
                "ParameterKey": "WFTextActionText",
                "DefaultValue": "",
                "Text": "上传密钥（部署时设置的 UPLOAD_KEY，不是网页密码）",
            },
        ],
        "WFWorkflowActions": actions,
    }


def main() -> None:
    site = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SITE).rstrip("/")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        unsigned = os.path.join(tmp, "unsigned.shortcut")
        with open(unsigned, "wb") as f:
            plistlib.dump(build(site), f, fmt=plistlib.FMT_BINARY)
        subprocess.run(
            ["shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", OUT],
            check=True,
        )
    print(f"已生成：{os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
