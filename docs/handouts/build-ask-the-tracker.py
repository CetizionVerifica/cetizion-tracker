from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable)

TEAL = colors.HexColor('#0f9d7e')
INK = colors.HexColor('#16181d')
GREY = colors.HexColor('#5b6270')
BOX = colors.HexColor('#f3f6f5')

ss = getSampleStyleSheet()
def S(name, **kw):
    base = dict(fontName='Helvetica', fontSize=10.5, leading=15.5, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

title    = S('title', fontName='Helvetica-Bold', fontSize=26, leading=30, textColor=INK, spaceAfter=4)
sub      = S('sub', fontSize=12.5, leading=18, textColor=GREY, spaceAfter=16)
h1       = S('h1', fontName='Helvetica-Bold', fontSize=15, leading=19, textColor=TEAL, spaceBefore=12, spaceAfter=6, keepWithNext=True)
body     = S('body', spaceAfter=7)
ask      = S('ask', fontName='Helvetica-Bold', fontSize=11.5, leading=16, textColor=INK, spaceAfter=3, keepWithNext=True)
answer   = S('answer', fontSize=10, leading=14.5, textColor=GREY, spaceAfter=10, leftIndent=10)
small    = S('small', fontSize=9.5, leading=14, textColor=GREY)
cell     = S('cell', fontSize=10, leading=14)
cellb    = S('cellb', fontSize=10, leading=14, fontName='Helvetica-Bold')

def rule():
    return HRFlowable(width='100%', thickness=0.7, color=colors.HexColor('#dfe4e3'),
                      spaceBefore=6, spaceAfter=12)

def callout(text, tint=BOX):
    t = Table([[Paragraph(text, body)]], colWidths=[165*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), tint),
        ('LEFTPADDING', (0,0), (-1,-1), 12), ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ('TOPPADDING', (0,0), (-1,-1), 10), ('BOTTOMPADDING', (0,0), (-1,-1), 10),
        ('LINEBEFORE', (0,0), (0,-1), 3, TEAL),
    ]))
    return t

def two_col(rows, widths=(52*mm, 113*mm)):
    data = [[Paragraph(a, cellb), Paragraph(b, cell)] for a, b in rows]
    t = Table(data, colWidths=list(widths))
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING', (0,0), (-1,-1), 5.5), ('BOTTOMPADDING', (0,0), (-1,-1), 5.5),
        ('LINEBELOW', (0,0), (-1,-2), 0.5, colors.HexColor('#e6eae9')),
    ]))
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 8.5)
    canvas.setFillColor(GREY)
    canvas.drawString(22*mm, 14*mm, 'Cetizion Tracker — asking it questions')
    canvas.drawRightString(188*mm, 14*mm, f'{doc.page}')
    canvas.restoreState()

story = []
A = story.append

A(Paragraph('Ask the tracker', title))
A(Paragraph('You can now ask the tracker questions the way you would ask a colleague, '
            'and hand it work the way you would hand it to one. This page explains what that means.', sub))
A(rule())

A(Paragraph('What is it, simply', h1))
A(Paragraph(
    'The tracker already knows everything: every deal, every invoice, who owes what, who you last spoke to. '
    'Until now the only way to get an answer out of it was to open the right screen and read.', body))
A(Paragraph(
    'Now you can just <b>ask</b>. You type a question in plain English into a chat window, and the tracker answers '
    'from the real, live data &mdash; the same numbers the screens show.', body))
A(callout('Think of it as a colleague who has read every record in the system, never forgets, '
          'is happy to be asked the same thing twice, and is available at 7am.'))

A(Paragraph('What it is good at', h1))

A(Paragraph('&ldquo;What is overdue, and who has not been chased?&rdquo;', ask))
A(Paragraph('It comes back oldest-first with the chasing history, so you get a plan rather than a list: '
            'which one nobody has called, which one already promised to pay, which one to pick up first.', answer))

A(Paragraph('&ldquo;Tell me everything about Northwind Steel before I ring them.&rdquo;', ask))
A(Paragraph('Their open deals, what they owe, how overdue, when you last spoke and what about &mdash; in one answer, '
            'instead of four screens.', answer))

A(Paragraph('&ldquo;What is in the inbox that nobody has answered?&rdquo;', ask))
A(Paragraph('Client emails where they wrote last and nothing has gone back, most overdue first. '
            'It tells you who wrote, roughly what about, whose it is and how late &mdash; never the email itself.', answer))

A(Paragraph('&ldquo;How many deals per sector, and what are they worth?&rdquo;', ask))
A(Paragraph('It can count or total anything, grouped by anything: by sector, by salesperson, by month. '
            'If the answer looks odd, ask it how many have nothing recorded in that column &mdash; usually that is the story.', answer))

A(Paragraph('&ldquo;What do we owe travel vendors?&rdquo; &mdash; &ldquo;When is money coming in?&rdquo;', ask))
A(Paragraph('What is owed, longest overdue first. And a month-by-month forecast: billed and unpaid, '
            'not yet billed, and what is likely from open deals.', answer))

A(Paragraph('&ldquo;What is blocking invoicing this week?&rdquo;', ask))
A(Paragraph('What is missing across the tracker and what it is holding up &mdash; invoiced stages with no invoice '
            'attached, purchase orders with nothing to reconcile against &mdash; with the page to go and fix each one.', answer))

A(Paragraph('&ldquo;What are my open tasks?&rdquo; &mdash; &ldquo;the Aurora one is done.&rdquo;', ask))
A(Paragraph('Soonest due first, with the record each sits on. And it can tick one off.', answer))

A(Paragraph('&ldquo;Log that I called them and they are paying Friday.&rdquo;', ask))
A(Paragraph('It writes that onto the record for you. It does <b>not</b> call anybody &mdash; it writes down that you did.', answer))

A(Paragraph('Giving it work, not just questions', h1))
A(Paragraph('It can also take data <b>in</b>. Paste this week&rsquo;s sales sheet, or a list of companies from a trade '
            'show, and it will read them into the tracker. This is an admin job, and it happens in two steps, always:', body))
A(two_col([
    ('1. It tells you what it would do',
     'How many new deals, which ones are already here, what it had to assume, and anything it could not read. '
     'Nothing is written at this point. Nothing at all'),
    ('2. You say go',
     'Only then does anything land. You can change your mind first &mdash; drop rows, keep the tracker&rsquo;s version '
     'of a client instead of the sheet&rsquo;s, change the assumptions and look again'),
]))
A(Spacer(1, 7))
A(callout('The first step is free and reversible because it is not real. '
          'Ask it what a sheet would do as often as you like.'))
A(Paragraph('If one row is wrong, <b>nothing</b> goes in &mdash; not the rest of the sheet around it. '
            'Half an imported list, with no record of which half, is worse than none of it.', body))

A(Paragraph('What it will not do', h1))
A(Paragraph('This is deliberate, not missing. Anything that moves money or tells a client something '
            'stays with a person:', body))
A(two_col([
    ('Raise an invoice', 'Money leaving or arriving is a decision, and this cannot take it back'),
    ('Record a payment', 'Same reason'),
    ('Move a deal&rsquo;s stage', 'That is a judgement about how likely a deal is. Yours, not its'),
    ('Send an email', 'It can write down a call you made. It cannot speak to a client'),
    ('Read a client&rsquo;s email', 'It sees who wrote and the subject line. Never the message'),
    ('Merge two clients', 'It will tell you which look like the same company spelt twice. Joining them '
                          'rewrites every record of one of them, so that is done on screen, by a person'),
    ('Delete anything', 'Never'),
]))

A(Paragraph('How much damage it could do', h1))
A(Paragraph('Worth being straight about, because it changed. A <b>read-only key</b> can do nothing at all &mdash; '
            'it is not even offered the tools that write. A key that may write can add a note or a task you did not want, '
            'which is a tidy-up.', body))
A(Paragraph('An <b>admin key</b> can import, and an import writes many records at once. That is the one to be careful '
            'with. It is why importing always shows you the plan first and waits, and why admin keys should be few.', body))

A(Paragraph('Two things worth knowing', h1))
A(Paragraph('<b>It only sees what you are allowed to see.</b> Your access is set when your key is made. '
            'A salesperson&rsquo;s key shows that salesperson&rsquo;s records. An admin key shows everything. '
            'It cannot be talked into showing more &mdash; the limit is in the database, not in the conversation.', body))
A(Paragraph('<b>Your questions are recorded.</b> Every question and answer is logged against your key, and an '
            'administrator can read that log. Treat it like the tracker itself: a company system, not a private one.', body))

A(Paragraph('Getting set up', h1))
A(two_col([
    ('1. Ask an admin', 'They make you a key in Settings. Say whether you need to read only, or also add notes and tasks'),
    ('2. Keep the key private', 'It is a password. Do not paste it into a chat, an email or a ticket. If one is seen, say so and it is cancelled in a click'),
    ('3. Ask a question', 'Plain English. No special words. If it misunderstands, say it differently'),
]))

A(Paragraph('If the answer looks wrong', h1))
A(Paragraph('It is reading the same records the screens show, so if a number looks wrong the record is usually '
            'wrong, not the answer. Three real examples:', body))
A(two_col([
    ('A deal is missing', 'It probably has no owner set, or the owner is spelled differently from your name'),
    ('A split by sector looks nonsense',
     'Most quotations have no sector filled in at all. Ask it how many &mdash; if the blank group is the biggest one, '
     'the split is not telling you much yet'),
    ('&ldquo;Average days to win&rdquo; is a negative number',
     'Some deals were typed in after they were won, so the tracker thinks they were won before they existed. '
     'That is about how the old spreadsheet was filled in, not about how fast we sell'),
]))
A(Spacer(1, 6))
A(Paragraph('If something looks off, say so &mdash; it is usually a record worth fixing.', body))

A(Spacer(1, 9))
A(Paragraph('It is not a separate system and there is nothing new to learn. It is the tracker, answering.', small))

doc = SimpleDocTemplate('/Users/hayyan/code/cetizion-tracker/docs/handouts/ask-the-tracker.pdf',
                        pagesize=A4, title='Ask the tracker',
                        author='Cetizion Verifica', subject='Using the tracker by asking it questions',
                        leftMargin=22*mm, rightMargin=22*mm, topMargin=17*mm, bottomMargin=18*mm)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('built')
