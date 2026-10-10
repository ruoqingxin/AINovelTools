use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use quote::{format_ident, quote};
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::visit::Visit;
use syn::{Expr, FnArg, GenericArgument, Item, Pat, PathArguments, ReturnType, Token, Type};

#[derive(Default)]
struct Registry {
    registered: BTreeSet<String>,
    commands: BTreeMap<String, syn::ItemFn>,
    events: BTreeMap<String, syn::Path>,
}

impl<'ast> Visit<'ast> for Registry {
    fn visit_macro(&mut self, value: &'ast syn::Macro) {
        if value.path == syn::parse_quote!(tauri::generate_handler) {
            let paths = Punctuated::<syn::Path, Token![,]>::parse_terminated
                .parse2(value.tokens.clone())
                .expect("parse command registration");
            for path in paths {
                assert_eq!(
                    path.segments.len(),
                    1,
                    "qualified registration needs support"
                );
                assert!(
                    self.registered.insert(path.segments[0].ident.to_string()),
                    "duplicate registration"
                );
            }
        }
        syn::visit::visit_macro(self, value);
    }

    fn visit_expr_method_call(&mut self, value: &'ast syn::ExprMethodCall) {
        if value.method == "emit" {
            let Some(Expr::Lit(event)) = value.args.first() else {
                panic!("event names must be string literals");
            };
            let syn::Lit::Str(event) = &event.lit else {
                panic!("event names must be strings");
            };
            let Some(Expr::Struct(payload)) = value.args.iter().nth(1) else {
                panic!("event payloads must have an explicit struct type");
            };
            if let Some(previous) = self.events.insert(event.value(), payload.path.clone()) {
                assert_eq!(previous, payload.path, "event payload type changed");
            }
        }
        syn::visit::visit_expr_method_call(self, value);
    }
}

fn read(path: &Path) -> syn::File {
    println!("cargo:rerun-if-changed={}", path.display());
    syn::parse_file(&std::fs::read_to_string(path).expect("read IPC source"))
        .expect("parse IPC source")
}

fn scan_commands(path: &Path, registry: &mut Registry) {
    println!("cargo:rerun-if-changed={}", path.display());
    let mut paths = std::fs::read_dir(path)
        .expect("read command directory")
        .map(|entry| entry.expect("command entry").path())
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            scan_commands(&path, registry);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let source = read(&path);
            // Only module-level command functions participate, never test fixtures.
            for item in &source.items {
                if let Item::Fn(function) = item {
                    if function
                        .attrs
                        .iter()
                        .any(|attr| attr.path() == &syn::parse_quote!(tauri::command))
                    {
                        assert!(
                            function
                                .attrs
                                .iter()
                                .all(|attr| !attr.path().is_ident("cfg")),
                            "conditional commands need explicit schema support"
                        );
                        assert!(
                            registry
                                .commands
                                .insert(function.sig.ident.to_string(), function.clone())
                                .is_none(),
                            "duplicate command"
                        );
                    }
                    registry.visit_block(&function.block);
                }
            }
        }
    }
}

fn is_injected(ty: &Type) -> bool {
    let Type::Path(ty) = ty else { return false };
    let names = ty
        .path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>();
    matches!(names.as_slice(), [root, name] if root == "tauri" && matches!(name.as_str(), "State" | "AppHandle" | "Window" | "WebviewWindow"))
}

fn result_types(output: &ReturnType) -> (Type, Type) {
    let ReturnType::Type(_, ty) = output else {
        return (syn::parse_quote!(()), syn::parse_quote!(()));
    };
    if let Type::Path(path) = ty.as_ref()
        && let Some(segment) = path.path.segments.last()
        && segment.ident == "Result"
    {
        let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
            panic!("invalid Result type");
        };
        let types = arguments
            .args
            .iter()
            .filter_map(|argument| match argument {
                GenericArgument::Type(ty) => Some(ty.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            types.len(),
            2,
            "Result must declare success and error types"
        );
        return (types[0].clone(), types[1].clone());
    }
    (ty.as_ref().clone(), syn::parse_quote!(()))
}

pub fn generate() {
    let mut registry = Registry::default();
    registry.visit_file(&read(Path::new("src/lib.rs")));
    scan_commands(Path::new("src/commands"), &mut registry);
    assert_eq!(
        registry.registered,
        registry.commands.keys().cloned().collect(),
        "registered commands and schema commands differ"
    );
    assert!(!registry.registered.is_empty(), "no commands found");
    let mut declarations = Vec::new();
    let mut registrations = Vec::new();
    for (name, function) in registry.commands {
        let request = format_ident!("Args_{}", name);
        let mut fields = Vec::new();
        let mut rename_all = "camelCase".to_owned();
        for attribute in &function.attrs {
            if attribute.path() == &syn::parse_quote!(tauri::command)
                && matches!(attribute.meta, syn::Meta::List(_))
            {
                attribute
                    .parse_nested_meta(|meta| {
                        if meta.path.is_ident("rename_all") {
                            let value: syn::LitStr = meta.value()?.parse()?;
                            rename_all = match value.value().as_str() {
                                "camelCase" => "camelCase".into(),
                                "snake_case" => "snake_case".into(),
                                _ => return Err(meta.error("unsupported command rename_all")),
                            };
                            Ok(())
                        } else {
                            Err(meta.error("unsupported command attribute; update IPC generator"))
                        }
                    })
                    .expect("parse command attributes");
            }
        }
        for argument in function.sig.inputs {
            let FnArg::Typed(argument) = argument else {
                panic!("command receiver")
            };
            if is_injected(&argument.ty) {
                continue;
            }
            let Pat::Ident(pattern) = argument.pat.as_ref() else {
                panic!("command argument pattern")
            };
            let ident = &pattern.ident;
            let ty = &argument.ty;
            fields.push(quote!(#ident: #ty));
        }
        let (success, error) = result_types(&function.sig.output);
        declarations.push(quote! {
            #[derive(schemars::JsonSchema)]
            #[serde(rename_all = #rename_all)]
            struct #request { #(#fields,)* }
        });
        registrations.push(quote! {
            requests.insert(#name.into(), input.subschema_for::<#request>().to_value());
            responses.insert(#name.into(), output.subschema_for::<#success>().to_value());
            errors.insert(#name.into(), output.subschema_for::<#error>().to_value());
        });
    }
    let event_registrations = registry.events.iter().map(|(name, payload)| {
        quote!(events.insert(#name.into(), output.subschema_for::<#payload>().to_value());)
    });
    let generated = quote! {
        #(#declarations)*
        fn collect(
            input: &mut schemars::SchemaGenerator,
            output: &mut schemars::SchemaGenerator,
        ) -> CollectedSchema {
            let mut requests = serde_json::Map::new();
            let mut responses = serde_json::Map::new();
            let mut errors = serde_json::Map::new();
            let mut events = serde_json::Map::new();
            #(#registrations)*
            #(#event_registrations)*
            CollectedSchema { requests, responses, errors, events }
        }
    };
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(output.join("ipc_schema.rs"), generated.to_string())
        .expect("write schema collector");
}
