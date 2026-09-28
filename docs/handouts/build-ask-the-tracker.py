from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, HRFlowable)

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
h1       = S('h1', fontName='Helvetica-Bold', fontSize=15, leading=19, textColor=TEAL, spaceBefore=12, spaceAfter=6)
body     = S('body', spaceAfter=7)
ask      = S('ask', fontName='Helvetica-Bold', fontSize=11.5, leading=16, textColor=INK, spaceAfter=3)
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
A(Paragraph('You can now ask the tracker questions the way you would ask a colleague. '
            'This page explains what that means and what to expect.', sub))
A(rule())

A(Paragraph('What is it, simply', h1))
A(Paragraph(
    'The tracker already knows everything: every deal, every invoice, who owes what, who you last spoke to. '
    'Until now the only way to get an answer out of it was to open the right screen and read.', body))
A(Paragraph(
    'Now you can just <b>ask</b>. You type a question in plain English into a chat window, and the tracker answers '
    'from the real, live data — the same numbers the screens show.', body))
A(callout('Think of it as a colleague who has read every record in the system, never forgets, '
          'is happy to be asked the same thing twice, and is available at 7am.'))

A(Paragraph('What it is good at', h1))

A(Paragraph('&ldquo;What is overdue, and who has not been chased?&rdquo;', ask))
A(Paragraph('It comes back oldest-first with the chasing history, so you get a plan rather than a list: '
            'which one nobody has called, which one already promised to pay, which one to pick up first.', answer))

A(Paragraph('&ldquo;Tell me everything about Northwind Steel before I ring them.&rdquo;', ask))
A(Paragraph('Their open deals, what they owe, how overdue, when you last spoke and what about — in one answer, '
            'instead of four screens.', answer))

A(Paragraph('&ldquo;Which deals have gone quiet?&rdquo;', ask))
A(Paragraph('Every open deal carries the date you last made contact, so it can simply tell you which ones '
            'have had nothing for a fortnight.', answer))

A(Paragraph('&ldquo;How did this quarter go?&rdquo;', ask))
A(Paragraph('Quoted, won, lost, win rate, what is still open. It also explains what each number counts, '
            'so you are not guessing whether &ldquo;win rate&rdquo; means what you think.', answer))

A(Paragraph('&ldquo;Log that I called them and they are paying Friday.&rdquo;', ask))
A(Paragraph('It writes that onto the record for you. It does <b>not</b> call anybody — it writes down that you did.', answer))

A(PageBreak())

A(Paragraph('What it will not do', h1))
A(Paragraph('This is deliberate, not missing. Anything that moves money or tells a client something '
            'stays with a person:', body))
A(two_col([
    ('Raise an invoice', 'Money leaving or arriving is a decision, and this cannot take it back'),
    ('Record a payment', 'Same reason'),
    ('Move a deal&rsquo;s stage', 'That is a judgement about how likely a deal is. Yours, not its'),
    ('Send an email', 'It can write down a call you made. It cannot speak to a client'),
    ('Delete anything', 'Never'),
]))
A(Spacer(1, 7))
A(callout('It can read almost everything and change almost nothing. '
          'The worst it can do on a bad day is add a note you did not want.'))

A(Paragraph('Two things worth knowing', h1))
A(Paragraph('<b>It only sees what you are allowed to see.</b> Your access is set when your key is made. '
            'A salesperson&rsquo;s key shows that salesperson&rsquo;s records. An admin key shows everything. '
            'It cannot be talked into showing more — the limit is in the database, not in the conversation.', body))
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
            'wrong, not the answer. Two real examples:', body))
A(two_col([
    ('A deal is missing', 'It probably has no owner set, or the owner is spelled differently from your name'),
    ('&ldquo;Average days to win&rdquo; is a negative number',
     'Some deals were typed in after they were won, so the tracker thinks they were won before they existed. '
     'That is about how the old spreadsheet was filled in, not about how fast we sell'),
]))
A(Spacer(1, 6))
A(Paragraph('If something looks off, say so — it is usually a record worth fixing.', body))

A(Spacer(1, 9))
A(Paragraph('It is not a separate system and there is nothing new to learn. It is the tracker, answering.', small))

doc = SimpleDocTemplate('/Users/hayyan/code/cetizion-tracker/docs/handouts/ask-the-tracker.pdf',
                        pagesize=A4, title='Ask the tracker',
                        author='Cetizion Verifica', subject='Using the tracker by asking it questions',
                        leftMargin=22*mm, rightMargin=22*mm, topMargin=17*mm, bottomMargin=18*mm)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('built')
