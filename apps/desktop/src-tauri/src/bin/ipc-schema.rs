fn main() {
    let schema = ainoveltools_desktop_lib::ipc_contract::schema();
    println!(
        "{}",
        serde_json::to_string(&schema).expect("serialize IPC schema")
    );
}
