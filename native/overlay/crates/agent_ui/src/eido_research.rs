use acp_thread::AcpThread;
use anyhow::{Result, anyhow, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use editor::{Editor, MultiBufferOffset};
use gpui::{DismissEvent, Entity, EventEmitter, FocusHandle, Focusable, Image, ImageFormat, Task, WeakEntity};
use serde_json::{Value, json};
use std::sync::Arc;
use ui::prelude::*;
use workspace::{ModalView, Workspace};
use crate::message_editor::MessageEditor;

pub(crate) fn reference(url: &str) -> Option<(String, String)> {
    let url=url::Url::parse(url).ok()?;
    if url.scheme()!="eido-source" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {return None;}
    let version=url.host_str()?.to_owned(); let citation=url.path().strip_prefix('/')?.to_owned();
    let valid=|v:&str| !v.is_empty() && v.len()<=128 && v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_');
    (valid(&version)&&valid(&citation)).then_some((version,citation))
}
/// Translate only known Eido presentation states; protocol values and unknown output stay raw.
pub(crate) fn state_label(state: &str, cx: &App) -> SharedString {
    match state {
        "Ready" => eido_i18n::tr(cx, "task.state_ready"),
        "Running" => eido_i18n::tr(cx, "task.state_running"),
        "Run finished" => eido_i18n::tr(cx, "task.state_run_finished"),
        "Cancelled" => eido_i18n::tr(cx, "task.state_cancelled"),
        "Run failed" => eido_i18n::tr(cx, "task.state_run_failed"),
        "Outcome unknown" => eido_i18n::tr(cx, "task.state_outcome_unknown"),
        "Waiting for input" => eido_i18n::tr(cx, "task.state_waiting_input"),
        "Stopping · waiting for the current operation" => eido_i18n::tr(cx, "task.state_stopping"),
        "Passed" => eido_i18n::tr(cx, "task.state_passed"),
        "Failed" => eido_i18n::tr(cx, "task.state_failed"),
        "Needs recheck" => eido_i18n::tr(cx, "task.state_needs_recheck"),
        "Inputs not rechecked" => eido_i18n::tr(cx, "task.state_inputs_not_rechecked"),
        "Not checked" => eido_i18n::tr(cx, "task.state_not_checked"),
        "Read" => eido_i18n::tr(cx, "task.state_read"),
        "Summary only" => eido_i18n::tr(cx, "task.state_summary_only"),
        "Partial" => eido_i18n::tr(cx, "task.state_partial"),
        "Not read" => eido_i18n::tr(cx, "task.state_not_read"),
        "Inputs changed" => eido_i18n::tr(cx, "task.state_inputs_changed"),
        "Inputs unavailable" => eido_i18n::tr(cx, "task.state_inputs_unavailable"),
        "Captured inputs current" => eido_i18n::tr(cx, "task.state_inputs_current"),
        "Verification cancelled" => eido_i18n::tr(cx, "task.state_verification_cancelled"),
        "Verification running" => eido_i18n::tr(cx, "task.state_verification_running"),
        "Verification not run" => eido_i18n::tr(cx, "task.state_verification_not_run"),
        "Verification could not finish" => eido_i18n::tr(cx, "task.state_verification_incomplete"),
        "Browser observation failed" => eido_i18n::tr(cx, "task.state_browser_failed"),
        "Verification failed" => eido_i18n::tr(cx, "task.state_verification_failed"),
        "Browser observed · No acceptance verdict" => eido_i18n::tr(cx, "task.state_browser_no_verdict"),
        "Preview captured · No checks run" => eido_i18n::tr(cx, "task.state_preview_no_checks"),
        "Captured context · read only" => eido_i18n::tr(cx, "task.state_captured"),
        "Checking current file…" => eido_i18n::tr(cx, "task.state_checking_file"),
        "Current file unavailable · snapshot preserved" => eido_i18n::tr(cx, "task.state_file_unavailable"),
        "Summary snapshot · current file not compared" => eido_i18n::tr(cx, "task.state_summary_snapshot"),
        "Matches current content" => eido_i18n::tr(cx, "task.state_matches"),
        "Content found at a different location" => eido_i18n::tr(cx, "task.state_moved"),
        "Content changed · snapshot preserved" => eido_i18n::tr(cx, "task.state_content_changed"),
        "Multiple matching locations · location not confirmed" => eido_i18n::tr(cx, "task.state_ambiguous"),
        "Delete file" => eido_i18n::tr(cx, "task.state_delete_file"),
        "File replacement" => eido_i18n::tr(cx, "task.state_file_replacement"),
        "Applying file change" => eido_i18n::tr(cx, "task.state_applying_file"),
        "File change accepted" => eido_i18n::tr(cx, "task.state_file_accepted"),
        "File change rejected" => eido_i18n::tr(cx, "task.state_file_rejected"),
        "Restoring original file" => eido_i18n::tr(cx, "task.state_restoring_file"),
        "Original file restored" => eido_i18n::tr(cx, "task.state_file_restored"),
        "Interrupted file change · review required" => eido_i18n::tr(cx, "task.state_file_interrupted"),
        "Current file kept" => eido_i18n::tr(cx, "task.state_file_kept"),
        "Accept" => eido_i18n::tr(cx, "task.state_accept"),
        "Reject" => eido_i18n::tr(cx, "task.state_reject"),
        "Restore Original" => eido_i18n::tr(cx, "task.state_restore_original"),
        "Keep Current" => eido_i18n::tr(cx, "task.state_keep_current"),
        "Open" => eido_i18n::tr(cx, "task.state_open"),
        "Open Again" => eido_i18n::tr(cx, "approval.open_again"),
        "Submit" => eido_i18n::tr(cx, "task.state_submit"),
        "Submitting…" => eido_i18n::tr(cx, "task.state_submitting"),
        "Only this time" => eido_i18n::tr(cx, "task.state_only_this_time"),
        "Always for terminal" => eido_i18n::tr(cx, "task.state_always_terminal"),
        "Always for edit file" => eido_i18n::tr(cx, "task.state_always_edit"),
        "Always for fetch" => eido_i18n::tr(cx, "task.state_always_fetch"),
        "unknown" => eido_i18n::tr(cx, "task.state_unknown"),
        "Unmatched" => eido_i18n::tr(cx, "task.state_unmatched"),
        "matched" => eido_i18n::tr(cx, "task.state_matched"),
        "exact" => eido_i18n::tr(cx, "task.state_exact"),
        "unmatched" => eido_i18n::tr(cx, "task.state_unmatched_lower"),
        "complete" => eido_i18n::tr(cx, "task.state_complete"),
        "partial" => eido_i18n::tr(cx, "task.state_partial_lower"),
        "failed" => eido_i18n::tr(cx, "task.state_failed_lower"),
        "billing_unknown" => eido_i18n::tr(cx, "task.state_billing_unknown"),
        "incomplete" => eido_i18n::tr(cx, "task.state_incomplete"),
        "not_started" => eido_i18n::tr(cx, "task.state_not_started"),
        _ => state.to_owned().into(),
    }
}

pub(crate) fn error_label(error: &str, cx: &App) -> SharedString {
    if error.is_empty() { return "".into(); }
    match error {
        "Saved source text unavailable." => eido_i18n::tr(cx, "research.error_source_text_unavailable"),
        "Source exceeds the native viewer limit." => eido_i18n::tr(cx, "research.error_source_size_limit"),
        "Source pagination did not advance." => eido_i18n::tr(cx, "research.error_source_pagination"),
        "Saved page unavailable." => eido_i18n::tr(cx, "research.error_page_unavailable"),
        "Page chunk exceeds the native limit." => eido_i18n::tr(cx, "research.error_page_chunk_limit"),
        "Page exceeds the native limit." => eido_i18n::tr(cx, "research.error_page_size_limit"),
        "Page version changed." => eido_i18n::tr(cx, "research.error_page_version_changed"),
        "Page pagination did not advance." => eido_i18n::tr(cx, "research.error_page_pagination"),
        "Saved page hash mismatch." => eido_i18n::tr(cx, "research.error_page_hash_mismatch"),
        "Native PDF rendering is supported on macOS only." => eido_i18n::tr(cx, "research.error_pdf_platform"),
        _ => eido_i18n::tr_args(cx, "research.error_detail", &[("error", error.to_owned())]),
    }
}

fn check_state(link:&Value)->&str {
    match link["freshness"].as_str(){
        Some("current")=>link["status"].as_str().unwrap_or("Not checked"),
        Some("needs_recheck"|"source_deleted")=>"Needs recheck",
        _=>"Inputs not rechecked",
    }
}
pub(crate) fn requirement_state(requirement:&Value,data:&Value)->String {
    let links=data["manifest"]["links"].as_array().cloned().unwrap_or_default();
    let criteria=requirement["criteria"].as_array().cloned().unwrap_or_default();
    if criteria.is_empty(){return "Not checked".into();}
    let states=criteria.iter().map(|criterion|links.iter().rev().find(|link|link["kind"]=="check"&&link["requirementId"]==requirement["requirementId"]&&link["revision"]==requirement["revision"]&&link["criterionId"]==criterion["criterionId"]).map(check_state).unwrap_or("Not checked")).collect::<Vec<_>>();
    if states.iter().all(|state|*state=="Passed"){"Passed".into()}else if states.contains(&"Failed"){"Failed".into()}else if states.contains(&"Needs recheck"){"Needs recheck".into()}else if states.contains(&"Inputs not rechecked"){"Inputs not rechecked".into()}else{"Not checked".into()}
}
fn source_state(source:&Value)->&'static str {
    match source["readState"].as_str(){Some("read")=>"Read",Some("summary_only")=>"Summary only",Some("partial")=>"Partial",Some("failed")=>"Failed",_=>"Not read"}
}
fn request(thread:&Entity<AcpThread>, mut body:Value, cx:&mut App)->Task<Result<Value>> {
    let thread=thread.read(cx);let connection=thread.connection().clone();let session=thread.session_id().clone();body["version"]=json!(1);body["sessionId"]=json!(session.to_string());
    connection.eido_research(session,body,cx)
}
pub(crate) fn open(thread:Entity<AcpThread>, composer:Entity<MessageEditor>, workspace:&WeakEntity<Workspace>, target:Option<(String,String)>,window:&mut Window,cx:&mut App) {
    let Some(workspace)=workspace.upgrade()else{return;};
    workspace.update(cx,|workspace,cx|workspace.toggle_modal(window,cx,move|window,cx|ResearchPanel::new(thread,composer,target,window,cx)));
}
struct CriterionFields {id:Option<String>,text:Entity<Editor>,command:Entity<Editor>,manual:bool,citations:Vec<String>}
fn input(text:&str,placeholder:&str,window:&mut Window,cx:&mut App)->Entity<Editor>{cx.new(|cx|{let mut e=Editor::single_line(window,cx);e.set_text(text,window,cx);e.set_placeholder_text(&eido_i18n::tr(cx,placeholder),window,cx);e})}
fn field(label:&str,editor:&Entity<Editor>,cx:&App)->AnyElement{v_flex().gap_1().child(Label::new(eido_i18n::tr(cx,label)).size(LabelSize::Small)).child(div().w_full().p_2().border_1().border_color(cx.theme().colors().border).child(editor.clone())).into_any_element()}
pub(crate) struct ResearchPanel {
    thread:Entity<AcpThread>,composer:Entity<MessageEditor>,editor:Entity<Editor>,data:Value,detail:Value,
    selected:Option<String>,citation:Option<String>,notice:eido_i18n::UiMessage,busy:bool,generation:u64,load:Option<Task<()>>,
    page:usize,page_image:Option<Arc<Image>>,page_manifest:Value,zoom:f64,
    delete_pending:bool,requirement:Option<Value>,title:Entity<Editor>,body:Entity<Editor>,criteria:Vec<CriterionFields>,editing:bool,locale_revision:u64,
}
impl ResearchPanel {
    fn new(thread:Entity<AcpThread>,composer:Entity<MessageEditor>,target:Option<(String,String)>,window:&mut Window,cx:&mut Context<Self>)->Self{
        let mut panel=Self{thread,composer,editor:crate::eido_reference::snapshot_editor("",window,cx),data:Value::Null,detail:Value::Null,
            selected:target.as_ref().map(|t|t.0.clone()),citation:target.map(|t|t.1),notice:eido_i18n::UiMessage::Raw(String::new()),busy:false,generation:0,load:None,
            page:0,page_image:None,page_manifest:Value::Null,zoom:1.0,delete_pending:false,requirement:None,title:input("","research.requirement_title",window,cx),body:input("","research.intended_behavior",window,cx),criteria:Vec::new(),editing:false,locale_revision:u64::MAX};
        cx.observe_global_in::<eido_i18n::LocaleState>(window, |this, window, cx| {
            this.refresh_language(window, cx); cx.notify();
        }).detach();
        panel.refresh_language(window,cx);panel.reload(window,cx);panel
    }
    fn refresh_language(&mut self,window:&mut Window,cx:&mut Context<Self>){
        let revision=cx.try_global::<eido_i18n::LocaleState>().map(|locale|locale.revision).unwrap_or(0);
        if self.locale_revision==revision{return;}self.locale_revision=revision;
        for (editor,key) in [(&self.title,"research.requirement_title"),(&self.body,"research.intended_behavior")]{
            let placeholder=eido_i18n::tr(cx,key);editor.update(cx,|editor,cx|editor.set_placeholder_text(&placeholder,window,cx));
        }
        for criterion in &self.criteria{
            for (editor,key) in [(&criterion.text,"research.criterion"),(&criterion.command,"research.check_command")]{
                let placeholder=eido_i18n::tr(cx,key);editor.update(cx,|editor,cx|editor.set_placeholder_text(&placeholder,window,cx));
            }
        }
    }
    fn reload(&mut self,window:&mut Window,cx:&mut Context<Self>){
        self.generation+=1;let generation=self.generation;self.busy=true;
        let task=request(&self.thread,json!({"action":"status"}),cx);
        self.load=Some(cx.spawn_in(window,async move|this,cx|{
            let result=task.await;this.update_in(cx,|this,window,cx|{
                if this.generation!=generation{return;}this.busy=false;
                match result{Ok(data)=>{this.data=data;if let Some(id)=this.selected.clone(){this.select(id,this.citation.clone(),window,cx);}},Err(error)=>this.notice=eido_i18n::UiMessage::Raw(error.to_string())};cx.notify();
            }).ok();
        }));
    }
    fn select(&mut self,id:String,citation:Option<String>,window:&mut Window,cx:&mut Context<Self>){
        self.generation+=1;let generation=self.generation;self.busy=true;self.notice=eido_i18n::UiMessage::Raw(String::new());self.delete_pending=false;self.selected=Some(id.clone());self.citation=citation.clone();self.page_image=None;
        let detail=request(&self.thread,json!({"action":"detail","versionId":id,"citationId":citation}),cx);let thread=self.thread.clone();
        self.load=Some(cx.spawn_in(window,async move|this,cx|{
            let result=async{
                let detail=detail.await?;let mut text=String::new();let mut offset=0;
                loop{let page=cx.update(|_,cx|request(&thread,json!({"action":"read","versionId":id,"offset":offset}),cx))?.await?;
                    text.push_str(page["text"].as_str().ok_or_else(||anyhow!("Saved source text unavailable."))?);ensure!(text.len()<=20*1024*1024,"Source exceeds the native viewer limit.");
                    match page["next"].as_u64(){Some(next)=>{ensure!(next>offset,"Source pagination did not advance.");offset=next;},None=>break}}
                Ok::<_,anyhow::Error>((detail,text))
            }.await;
            this.update_in(cx,|this,window,cx|{
                if this.generation!=generation{return;}this.busy=false;
                match result{Ok((detail,text))=>{
                    this.detail=detail;this.editor=crate::eido_reference::snapshot_editor(&text,window,cx);
                    let citation=this.detail["citations"].as_array().and_then(|a|a.first());
                    if let Some(range)=citation.and_then(|c|c["range"].as_array()).filter(|r|r.len()==2){
                        if let (Some(start),Some(end))=(range[0].as_u64(),range[1].as_u64()){
                            if start<=end&&(end as usize)<=text.len(){this.editor.update(cx,|editor,cx|editor.change_selections(Default::default(),window,cx,|s|s.select_ranges([MultiBufferOffset(start as usize)..MultiBufferOffset(end as usize)])));}
                        }
                    }
                    this.page=citation.and_then(|c|c["regions"].as_array()).and_then(|r|r.first()).and_then(|r|r["pageIndex"].as_u64()).unwrap_or(0) as usize;
                    if this.detail["extraction"].is_object(){this.load_page(window,cx);}
                },Err(error)=>{this.notice=eido_i18n::UiMessage::Raw(error.to_string());this.detail=Value::Null;this.editor=crate::eido_reference::snapshot_editor("",window,cx);}}cx.notify();
            }).ok();
        }));
    }
    fn load_page(&mut self,window:&mut Window,cx:&mut Context<Self>){
        let Some(id)=self.selected.clone()else{return;};let page=self.page;let generation=self.generation;let thread=self.thread.clone();self.page_image=None;
        cx.spawn_in(window,async move|this,cx|{
            let result=async{let mut bytes=Vec::new();let mut offset=0;let mut manifest=Value::Null;let mut hash=String::new();
                loop{let reply=cx.update(|_,cx|request(&thread,json!({"action":"page","versionId":id,"pageIndex":page,"offset":offset}),cx))?.await?;
                    let data=STANDARD.decode(reply["content"].as_str().ok_or_else(||anyhow!("Saved page unavailable."))?)?;ensure!(data.len()<=262144,"Page chunk exceeds the native limit.");bytes.extend(data);ensure!(bytes.len()<=20*1024*1024,"Page exceeds the native limit.");
                    if offset==0{manifest=reply["manifest"].clone();hash=reply["hash"].as_str().unwrap_or_default().to_owned();}else{ensure!(reply["hash"]==hash,"Page version changed.");}
                    match reply["next"].as_u64(){Some(next)=>{ensure!(next>offset,"Page pagination did not advance.");offset=next;},None=>break}}
                ensure!(crate::eido_document::hash(&bytes)==hash,"Saved page hash mismatch.");Ok::<_,anyhow::Error>((Arc::new(Image::from_bytes(ImageFormat::Png,bytes)),manifest))}.await;
            this.update(cx,|this,cx|{if this.generation!=generation||this.page!=page{return;}match result{Ok((image,manifest))=>{this.page_image=Some(image);this.page_manifest=manifest;},Err(error)=>this.notice=eido_i18n::UiMessage::Raw(error.to_string())};cx.notify();}).ok();
        }).detach();
    }
    fn cite_selection(&mut self,window:&mut Window,cx:&mut Context<Self>){
        let Some(version)=self.selected.clone()else{return;};let (text,range)=self.editor.update(cx,|editor,cx|{let selection=editor.selections.newest::<MultiBufferOffset>(&editor.display_snapshot(cx));(editor.text(cx),selection.start.0..selection.end.0)});
        let Some(quote)=text.get(range.clone()).filter(|text|!text.is_empty())else{self.notice=eido_i18n::UiMessage::Key("research.select_quote", vec![]);cx.notify();return;};
        let task=request(&self.thread,json!({"action":"cite","versionId":version,"quote":quote,"range":[range.start,range.end]}),cx);
        cx.spawn_in(window,async move|this,cx|{let result=task.await;this.update_in(cx,|this,window,cx|{match result{Ok(citation)=>{this.citation=citation["citationId"].as_str().map(str::to_owned);this.notice=eido_i18n::UiMessage::Key("research.citation_notice", vec![("state", citation["matchState"].as_str().unwrap_or("unmatched").to_owned())]);if let Some(id)=this.selected.clone(){this.select(id,this.citation.clone(),window,cx);}},Err(error)=>this.notice=eido_i18n::UiMessage::Raw(error.to_string())};cx.notify();}).ok();}).detach();
    }
    fn draft_requirement(&mut self,old:Option<Value>,window:&mut Window,cx:&mut Context<Self>){
        self.editing=true;self.requirement=old.clone();let data=old.unwrap_or_else(||json!({"title":"","text":"","criteria":[{"text":"","checkType":"manual","sourceCitationIds":self.citation.iter().collect::<Vec<_>>()}]}));
        self.title=input(data["title"].as_str().unwrap_or_default(),"research.requirement_title",window,cx);self.body=input(data["text"].as_str().unwrap_or_default(),"research.intended_behavior_short",window,cx);
        self.criteria=data["criteria"].as_array().into_iter().flatten().map(|c|CriterionFields{id:c["criterionId"].as_str().map(str::to_owned),text:input(c["text"].as_str().unwrap_or_default(),"research.criterion",window,cx),command:input(c["checkSpec"].as_str().unwrap_or_default(),"research.exact_command",window,cx),manual:c["checkType"]!="command",citations:c["sourceCitationIds"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(str::to_owned)).collect()}).collect();cx.notify();
    }
    fn save_requirement(&mut self,window:&mut Window,cx:&mut Context<Self>){
        let citation_ids=self.requirement.as_ref().map(|r|r["citationIds"].clone()).unwrap_or_else(||json!(self.citation.iter().collect::<Vec<_>>()));
        let mut body=json!({"action":if self.requirement.is_some(){"update"}else{"create"},"title":self.title.read(cx).text(cx),"text":self.body.read(cx).text(cx),"citationIds":citation_ids,
            "relatedFiles":self.requirement.as_ref().map(|r|r["relatedFiles"].clone()).unwrap_or_else(||json!([])),"criteria":self.criteria.iter().map(|c|{
                let mut item=json!({"text":c.text.read(cx).text(cx),"checkType":if c.manual{"manual"}else{"command"},"sourceCitationIds":c.citations});
                if !c.manual{item["checkSpec"]=json!(c.command.read(cx).text(cx));}if let Some(id)=&c.id{item["criterionId"]=json!(id);}item}).collect::<Vec<_>>()});
        if let Some(old)=&self.requirement{body["requirementId"]=old["requirementId"].clone();body["expectedRevision"]=old["revision"].clone();}
        let task=request(&self.thread,json!({"action":"requirements","operationId":uuid::Uuid::new_v4().to_string(),"request":body}),cx);self.busy=true;
        cx.spawn_in(window,async move|this,cx|{let result=task.await;this.update_in(cx,|this,window,cx|{this.busy=false;match result{Ok(_)=>{this.editing=false;this.reload(window,cx);},Err(error)=>this.notice=eido_i18n::UiMessage::Raw(error.to_string())};cx.notify();}).ok();}).detach();
    }
    fn manual_check(&mut self,index:usize,outcome:&str,window:&mut Window,cx:&mut Context<Self>){
        let Some(requirement)=&self.requirement else{return;};let Some(criterion)=self.criteria.get(index)else{return;};
        let task=request(&self.thread,json!({"action":"manual-check","requirementId":requirement["requirementId"],"revision":requirement["revision"],"criterionId":criterion.id,"outcome":outcome,"observation":criterion.command.read(cx).text(cx)}),cx);self.busy=true;
        cx.spawn_in(window,async move|this,cx|{let result=task.await;this.update_in(cx,|this,window,cx|{this.busy=false;this.notice=match result{Ok(_)=>eido_i18n::UiMessage::Key("research.manual_recorded", vec![]),Err(error)=>eido_i18n::UiMessage::Raw(error.to_string())};this.reload(window,cx);cx.notify();}).ok();}).detach();
    }
    fn delete_source(&mut self,window:&mut Window,cx:&mut Context<Self>){
        let Some(id)=self.selected.clone()else{return;};
        if !self.delete_pending{self.delete_pending=true;self.notice=eido_i18n::UiMessage::Key("research.delete_confirmation", vec![]);cx.notify();return;}
        let task=request(&self.thread,json!({"action":"delete","operationId":uuid::Uuid::new_v4().to_string(),"versionIds":[id],"expectedRevision":self.data["manifest"]["revision"]}),cx);self.busy=true;
        cx.spawn_in(window,async move|this,cx|{let result=task.await;this.update_in(cx,|this,window,cx|{this.busy=false;match result{Ok(_)=>{this.selected=None;this.citation=None;this.detail=Value::Null;this.page_image=None;this.notice=eido_i18n::UiMessage::Key("research.source_deleted", vec![]);this.reload(window,cx);},Err(error)=>{this.notice=eido_i18n::UiMessage::Raw(error.to_string());this.delete_pending=false;this.reload(window,cx);}}cx.notify();}).ok();}).detach();
    }
    fn append_prompt(&self,text:String,window:&mut Window,cx:&mut Context<Self>){
        self.composer.update(cx,|editor,cx|{let end=editor.text(cx).len();editor.set_cursor_offset(end,window,cx);editor.insert_text(&format!("\n{text}"),window,cx);});cx.emit(DismissEvent);
    }
}
impl EventEmitter<DismissEvent> for ResearchPanel{}
impl ModalView for ResearchPanel{}
impl Focusable for ResearchPanel{fn focus_handle(&self,cx:&App)->FocusHandle{self.editor.focus_handle(cx)}}
impl Render for ResearchPanel{
    fn render(&mut self,window:&mut Window,cx:&mut Context<Self>)->impl IntoElement{
        self.refresh_language(window,cx);
        let width=f32::from(window.viewport_size().width).min(1100.)-40.;
        let sources=self.data["manifest"]["sources"].as_array().cloned().unwrap_or_default();
        let requirements=self.data["manifest"]["requirements"].as_array().cloned().unwrap_or_default();
        let latest:Vec<_>=requirements.iter().filter(|r|!requirements.iter().any(|n|n["requirementId"]==r["requirementId"]&&n["revision"].as_u64()>r["revision"].as_u64())).cloned().collect();
        let mut list=v_flex().id("research-source-list").gap_1().w(px(250.)).h_full().overflow_y_scroll();
        for (index,source) in sources.iter().enumerate(){let id=source["versionId"].as_str().unwrap_or_default().to_owned();list=list.child(Button::new(("saved-source",index),format!("{} · {}",state_label(source_state(source),cx),source["title"].as_str().or(source["originalName"].as_str()).unwrap_or("Saved source"))).full_width().label_size(LabelSize::Small).on_click(cx.listener(move|this,_,window,cx|this.select(id.clone(),None,window,cx))));}
        list=list.child(Label::new(eido_i18n::tr(cx, "research.requirements")).size(LabelSize::Small));
        for (index,requirement) in latest.into_iter().enumerate(){let old=requirement.clone();list=list.child(v_flex().gap_1().child(Button::new(("requirement",index),format!("{} · r{} · {}",requirement["title"].as_str().unwrap_or("Requirement"),requirement["revision"],state_label(&requirement_state(&requirement,&self.data),cx))).label_size(LabelSize::Small).on_click(cx.listener(move|this,_,window,cx|this.draft_requirement(Some(old.clone()),window,cx))))
            .child(Button::new(("implement-requirement",index), eido_i18n::tr(cx, "research.implement")).label_size(LabelSize::Small).on_click(cx.listener(move|this,_,window,cx|{let id=requirement["requirementId"].as_str().unwrap_or_default().to_owned();let revision=requirement["revision"].as_u64().unwrap_or(0);let name=requirement["title"].as_str().unwrap_or_default().to_owned();
                    let uri=acp_thread::MentionUri::Requirement{id:id.clone(),revision,name:name.clone()};
                    let resource=agent_client_protocol::schema::v1::ContentBlock::Resource(agent_client_protocol::schema::v1::EmbeddedResource::new(agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(agent_client_protocol::schema::v1::TextResourceContents::new(json!({"version":1,"requirementId":id,"revision":revision}).to_string(),uri.to_uri().to_string()).mime_type("application/vnd.eido.requirement+json"))));
                    this.composer.update(cx,|editor,cx|{let empty=editor.text(cx).trim().is_empty();editor.set_cursor_offset(editor.text(cx).len(),window,cx);editor.append_message(vec![format!("Implement requirement {name}. Read its saved citations and run its acceptance checks. ").into(),resource],Some("\n"),window,cx);if empty{editor.send(cx);}});cx.emit(DismissEvent);}))))}
        let mut right=v_flex().flex_1().min_w_0().gap_2();
        if self.editing{
            if let Some(requirement)=&self.requirement{
                right=right.child(Label::new(format!("{} · {}",requirement["requirementId"],state_label(&requirement_state(requirement,&self.data),cx))).size(LabelSize::Small));
                let citations=self.data["manifest"]["citations"].as_array().cloned().unwrap_or_default();
                for(index,citation)in citations.iter().filter(|c|requirement["citationIds"].as_array().is_some_and(|ids|ids.contains(&c["citationId"]))).enumerate(){let version=citation["sourceVersionId"].as_str().unwrap_or_default().to_owned();let id=citation["citationId"].as_str().unwrap_or_default().to_owned();right=right.child(Button::new(("requirement-source",index),eido_i18n::tr_args(cx, "research.source_quote", &[("quote", citation["quote"].as_str().unwrap_or_default().to_owned())])).label_size(LabelSize::Small).on_click(cx.listener(move|this,_,window,cx|{this.editing=false;this.select(version.clone(),Some(id.clone()),window,cx);})));}
                for(index,link)in self.data["manifest"]["links"].as_array().into_iter().flatten().filter(|l|l["requirementId"]==requirement["requirementId"]&&l["revision"]==requirement["revision"]).enumerate(){right=right.child(Label::new(format!("{} · {} · {}",link["kind"].as_str().unwrap_or("Link"),link["path"].as_str().or(link["runId"].as_str()).unwrap_or_default(),state_label(if link["kind"]=="check"{check_state(link)}else{"Not checked"},cx))).size(LabelSize::XSmall).color(Color::Muted));let _=index;}
            }
            right=right.child(field("research.field_title",&self.title,cx)).child(field("research.field_requirement",&self.body,cx));
            for(index,c)in self.criteria.iter().enumerate(){right=right.child(field("research.criterion",&c.text,cx)).child(Button::new(("criterion-kind",index),if c.manual{eido_i18n::tr(cx, "research.manual_observation")}else{eido_i18n::tr(cx, "research.command_check")}).label_size(LabelSize::Small).on_click(cx.listener(move|this,_,_,cx|{this.criteria[index].manual=!this.criteria[index].manual;cx.notify();}))).when(!c.manual,|this|this.child(field("research.check_command",&c.command,cx)));}
            if self.requirement.is_some(){for(index,c)in self.criteria.iter().enumerate(){if c.manual{right=right.child(field("research.observed_behavior",&c.command,cx)).child(h_flex().gap_2().child(Button::new(("manual-pass",index), eido_i18n::tr(cx, "research.manual_pass")).disabled(self.busy).on_click(cx.listener(move|this,_,window,cx|this.manual_check(index,"Passed",window,cx)))).child(Button::new(("manual-fail",index), eido_i18n::tr(cx, "research.manual_failure")).disabled(self.busy).on_click(cx.listener(move|this,_,window,cx|this.manual_check(index,"Failed",window,cx)))));}}}
            right=right.child(h_flex().gap_2().child(Button::new("add-criterion", eido_i18n::tr(cx, "research.add_criterion")).disabled(self.criteria.len()>=50).on_click(cx.listener(|this,_,window,cx|{this.criteria.push(CriterionFields{id:None,text:input("","research.criterion",window,cx),command:input("","research.check_command",window,cx),manual:true,citations:this.citation.iter().cloned().collect()});cx.notify();}))).child(Button::new("save-requirement", eido_i18n::tr(cx, "research.save_revision")).disabled(self.busy).on_click(cx.listener(|this,_,window,cx|this.save_requirement(window,cx)))));
        }else{
            if self.detail.is_null(){right=right.child(Label::new(if self.selected.is_some(){eido_i18n::tr(cx, "research.source_unavailable")}else{eido_i18n::tr(cx, "research.select_saved")}).size(LabelSize::Small).color(Color::Muted));}
            if !self.detail.is_null(){let source=&self.detail["source"];right=right.child(Label::new(format!("{} · {}",state_label(source_state(source),cx),source["capturedAt"].as_str().unwrap_or_default())).size(LabelSize::Small)).child(Label::new(eido_i18n::tr_args(cx, "research.version", &[("version", source["versionId"].as_str().unwrap_or_default().to_owned())])).size(LabelSize::XSmall).color(Color::Muted));
                if let Some(citation)=self.detail["citations"].as_array().and_then(|a|a.first()){right=right.child(Label::new(eido_i18n::tr_args(cx, "research.citation_state", &[("state", state_label(citation["matchState"].as_str().unwrap_or("Unmatched"),cx).to_string())])).size(LabelSize::Small));}
                if let Some(url)=source["canonicalUrl"].as_str(){let url=url.to_owned();right=right.child(Button::new("refresh-source", eido_i18n::tr(cx, "research.refresh_version")).on_click(cx.listener(move|this,_,window,cx|this.append_prompt(format!("Fetch {} again as a new saved version. Use the existing source as parentVersionId and keep it available.",url),window,cx))));}
            }
            if self.selected.is_some(){right=right.child(Button::new("delete-local-source",if self.delete_pending{eido_i18n::tr(cx, "research.confirm_delete")}else{eido_i18n::tr(cx, "research.delete_version")}).disabled(self.busy).on_click(cx.listener(|this,_,window,cx|this.delete_source(window,cx))));}
            if self.detail["extraction"].is_object(){
                let remaining=self.detail["extraction"]["missingPages"].clone();
                right=right.child(h_flex().gap_2().child(Button::new("continue-document", eido_i18n::tr(cx, "research.continue_document")).on_click(cx.listener(move|this,_,window,cx|{this.composer.update(cx,|editor,cx|editor.add_documents_from_picker(window,cx));this.append_prompt(format!("Continue extracting the selected original document, pages {remaining} (zero-based). Reuse complete pages. If an earlier page attempt is unknown, stop and explain before retrying."),window,cx);})))
                    .child(Button::new("retry-document", eido_i18n::tr(cx, "research.retry_document")).on_click(cx.listener(|this,_,window,cx|{this.composer.update(cx,|editor,cx|editor.add_documents_from_picker(window,cx));this.append_prompt("Extract the newly selected original document as a new version with reextract=true. I authorize new OCR attempts, including pages with unknown previous billing. Preserve old versions.".into(),window,cx);}))))
                    .child(Label::new(eido_i18n::tr(cx, "research.retry_cost")).size(LabelSize::Small).color(Color::Muted));
                right=right.child(Label::new(eido_i18n::tr_args(cx, "research.extraction_state", &[("state", state_label(self.detail["extraction"]["status"].as_str().unwrap_or("unknown"),cx).to_string()), ("pages", self.detail["extraction"]["missingPages"].to_string())])).size(LabelSize::Small).color(Color::Muted));
                let count=self.detail["extraction"]["pageCount"].as_u64().unwrap_or(1) as usize;
                right=right.child(h_flex().gap_2().child(Button::new("previous-page", eido_i18n::tr(cx, "research.previous")).disabled(self.page==0).on_click(cx.listener(|this,_,window,cx|{this.page=this.page.saturating_sub(1);this.load_page(window,cx);}))).child(Label::new(eido_i18n::tr_args(cx, "research.page_count", &[("page", (self.page+1).to_string()), ("count", count.to_string())]))).child(Button::new("next-page", eido_i18n::tr(cx, "research.next")).disabled(self.page+1>=count).on_click(cx.listener(|this,_,window,cx|{this.page+=1;this.load_page(window,cx);})))
                    .child(Button::new("zoom-page", eido_i18n::tr(cx, "research.zoom")).on_click(cx.listener(|this,_,_,cx|{this.zoom=if this.zoom>=2.{0.75}else{this.zoom+0.25};cx.notify();}))));
                let boxes=self.detail["citations"].as_array().into_iter().flatten().flat_map(|c|c["regions"].as_array().into_iter().flatten()).filter(|r|r["pageIndex"].as_u64()==Some(self.page as u64)).flat_map(|r|r["boxes"].as_array().into_iter().flatten()).filter_map(|b|serde_json::from_value::<[f64;4]>(b.clone()).ok()).collect::<Vec<_>>();
                if let Some(image)=&self.page_image{right=right.child(crate::eido_document::page_element(image.clone(),&self.page_manifest,&boxes,self.zoom,width-300.,cx));}
                if boxes.is_empty(){right=right.child(Label::new(eido_i18n::tr(cx, "research.region_unavailable")).size(LabelSize::Small).color(Color::Muted));}
            }
            right=right.child(div().h(px(if self.page_image.is_some(){130.}else{350.})).child(self.editor.clone())).child(Button::new("cite-source-selection", eido_i18n::tr(cx, "research.use_citation")).disabled(self.selected.is_none()).on_click(cx.listener(|this,_,window,cx|this.cite_selection(window,cx)))).child(Button::new("new-requirement", eido_i18n::tr(cx, "research.create_requirement")).on_click(cx.listener(|this,_,window,cx|this.draft_requirement(None,window,cx))));
        }
        v_flex().key_context("ResearchPanel").track_focus(&self.focus_handle(cx)).on_action(cx.listener(|_,_:&menu::Cancel,_,cx|cx.emit(DismissEvent)))
            .w(px(width)).max_h(window.viewport_size().height-px(40.)).p_4().gap_3().bg(cx.theme().colors().editor_background).border_1().border_color(cx.theme().colors().border).rounded_lg()
            .child(h_flex().justify_between().child(Label::new(eido_i18n::tr(cx, "research.title"))).child(h_flex().gap_2().child(Button::new("reload-research", eido_i18n::tr(cx, "research.reload")).disabled(self.busy).on_click(cx.listener(|this,_,window,cx|this.reload(window,cx)))).child(IconButton::new("close-research",IconName::Close).on_click(cx.listener(|_,_,_,cx|cx.emit(DismissEvent))))))
            .child(Label::new(if self.busy{eido_i18n::tr(cx, "research.loading")}else{match &self.notice {
                eido_i18n::UiMessage::Raw(error)=>error_label(error,cx),
                eido_i18n::UiMessage::Key("research.citation_notice",args)=>eido_i18n::tr_args(cx,"research.citation_notice",&[("state",state_label(args.first().map(|(_,value)|value.as_str()).unwrap_or("unmatched"),cx).to_string())]),
                _=>self.notice.render(cx),
            }}).size(LabelSize::Small).color(Color::Muted))
            .child(h_flex().items_start().gap_4().min_h_0().child(list).child(right))
            .children([("This task",&self.data["usage"]["task"]),("Global",&self.data["usage"]["global"])].into_iter().map(|(label,usage)|Label::new(eido_i18n::tr_args(cx, "research.usage", &[("scope", if label=="This task"{eido_i18n::tr(cx, "research.scope_task").to_string()}else{eido_i18n::tr(cx, "research.scope_global").to_string()}), ("attempts", usage["attempts"].as_u64().unwrap_or(0).to_string()), ("successful", usage["successful"].as_u64().unwrap_or(0).to_string()), ("unknown", usage["unknown"].as_u64().unwrap_or(0).to_string()), ("pages", usage["ocrPages"].as_u64().unwrap_or(0).to_string()), ("bytes", usage["uploadedBytes"].as_u64().unwrap_or(0).to_string()), ("amount", format!("{:.4}",usage["estimatedCny"].as_f64().unwrap_or(0.)))])).size(LabelSize::XSmall).color(Color::Muted)))
            .child(Label::new(eido_i18n::tr(cx, "research.usage_note")).size(LabelSize::XSmall).color(Color::Muted))
    }
}
#[cfg(test)]mod tests{use super::*;#[test]fn test_eido_research_reference_rejects_foreign_schemes_and_extra_permissions(){assert_eq!(reference("eido-source://version/citation"),Some(("version".into(),"citation".into())));for url in ["https://example.com","eido-source://v/c?path=/private","eido-source://v/a/b","eido-source://user@v/c"]{assert!(reference(url).is_none());}assert_eq!(source_state(&json!({"readState":"summary_only"})),"Summary only");}}

#[cfg(test)]
mod requirement_tests {
    use super::*;
    #[test]
    fn test_eido_requirement_status_requires_exact_revision_and_all_criteria(){
        let requirement=json!({"requirementId":"r","revision":2,"criteria":[{"criterionId":"c"}]});
        let mut data=json!({"manifest":{"links":[{"kind":"check","requirementId":"r","revision":1,"criterionId":"c","status":"Passed","freshness":"current"}]}});
        assert_eq!(requirement_state(&requirement,&data),"Not checked");
        data["manifest"]["links"][0]["revision"]=json!(2);assert_eq!(requirement_state(&requirement,&data),"Passed");
        data["manifest"]["links"][0]["status"]=json!("Needs recheck");assert_eq!(requirement_state(&requirement,&data),"Needs recheck");
    }
    #[test]
    fn test_eido_requirement_status_never_trusts_stale_passed_links(){
        let requirement=json!({"requirementId":"r","revision":1,"criteria":[{"criterionId":"c"}]});
        for (freshness,expected) in [("needs_recheck","Needs recheck"),("source_deleted","Needs recheck"),("inputs_not_rechecked","Inputs not rechecked")]{
            let data=json!({"manifest":{"links":[{"kind":"check","requirementId":"r","revision":1,"criterionId":"c","status":"Passed","freshness":freshness}]}});
            assert_eq!(requirement_state(&requirement,&data),expected);
        }
    }

}
